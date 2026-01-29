import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Railway API configuration
const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

// Supabase API configuration
const SUPABASE_API_URL = 'https://api.supabase.com/v1';

// ============================================
// RAILWAY API FUNCTIONS
// ============================================

async function railwayGraphQL(token, query, variables = {}) {
  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();
  if (data.errors) {
    throw new Error(data.errors[0].message);
  }
  return data.data;
}

async function railwayGetProjects(token) {
  const query = `
    query {
      me {
        projects {
          edges {
            node {
              id
              name
              description
              createdAt
              environments {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
              services {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await railwayGraphQL(token, query);
  return data.me.projects.edges.map(e => ({
    ...e.node,
    environments: e.node.environments.edges.map(env => env.node),
    services: e.node.services.edges.map(svc => svc.node)
  }));
}

async function railwayCreateProject(token, name, description = '') {
  const query = `
    mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        name
        environments {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;
  const data = await railwayGraphQL(token, query, {
    input: { name, description }
  });
  return {
    ...data.projectCreate,
    environments: data.projectCreate.environments.edges.map(e => e.node)
  };
}

async function railwayCreateService(token, projectId, environmentId, repoUrl, branch = 'main') {
  const query = `
    mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
      }
    }
  `;
  const data = await railwayGraphQL(token, query, {
    input: {
      projectId,
      source: { repo: repoUrl },
      branch
    }
  });
  return data.serviceCreate;
}

async function railwayDeploy(token, serviceId, environmentId) {
  const query = `
    mutation($input: ServiceInstanceDeployInput!) {
      serviceInstanceDeploy(input: $input)
    }
  `;
  const data = await railwayGraphQL(token, query, {
    input: { serviceId, environmentId }
  });
  return { success: true, deploymentId: data.serviceInstanceDeploy };
}

async function railwayGenerateDomain(token, serviceId, environmentId) {
  const query = `
    mutation($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        id
        domain
      }
    }
  `;
  const data = await railwayGraphQL(token, query, {
    input: { serviceId, environmentId }
  });
  return data.serviceDomainCreate;
}

async function railwaySetVariables(token, serviceId, environmentId, variables) {
  const query = `
    mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;
  await railwayGraphQL(token, query, {
    input: {
      serviceId,
      environmentId,
      variables
    }
  });
  return { success: true };
}

async function railwayGetDeployments(token, projectId) {
  const query = `
    query($projectId: String!) {
      deployments(input: { projectId: $projectId }) {
        edges {
          node {
            id
            status
            createdAt
            service {
              name
            }
          }
        }
      }
    }
  `;
  const data = await railwayGraphQL(token, query, { projectId });
  return data.deployments.edges.map(e => e.node);
}

// ============================================
// SUPABASE API FUNCTIONS
// ============================================

async function supabaseRequest(token, endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${SUPABASE_API_URL}${endpoint}`, options);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase API error: ${error}`);
  }
  return response.json();
}

async function supabaseGetProjects(token) {
  return supabaseRequest(token, '/projects');
}

async function supabaseGetProject(token, projectRef) {
  return supabaseRequest(token, `/projects/${projectRef}`);
}

async function supabaseCreateProject(token, name, organizationId, dbPassword, region = 'us-east-1') {
  return supabaseRequest(token, '/projects', 'POST', {
    name,
    organization_id: organizationId,
    db_pass: dbPassword,
    region,
    plan: 'free'
  });
}

async function supabaseGetOrganizations(token) {
  return supabaseRequest(token, '/organizations');
}

async function supabaseRunSQL(token, projectRef, sql) {
  return supabaseRequest(token, `/projects/${projectRef}/database/query`, 'POST', { query: sql });
}

async function supabaseGetTables(token, projectRef) {
  const sql = `
    SELECT table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `;
  return supabaseRunSQL(token, projectRef, sql);
}

async function supabaseCreateTable(token, projectRef, tableName, columns) {
  const columnDefs = columns.map(col =>
    `${col.name} ${col.type}${col.primaryKey ? ' PRIMARY KEY' : ''}${col.notNull ? ' NOT NULL' : ''}${col.default ? ` DEFAULT ${col.default}` : ''}`
  ).join(', ');

  const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs});`;
  return supabaseRunSQL(token, projectRef, sql);
}

// ============================================
// MCP SERVER SETUP
// ============================================

function createMCPServer() {
  const server = new Server(
    { name: 'vocal-bridge-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List all available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // Railway Tools
      {
        name: 'railway_list_projects',
        description: 'List all Railway projects for the authenticated user',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Railway API token' }
          },
          required: ['token']
        }
      },
      {
        name: 'railway_create_project',
        description: 'Create a new Railway project',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Railway API token' },
            name: { type: 'string', description: 'Project name' },
            description: { type: 'string', description: 'Project description' }
          },
          required: ['token', 'name']
        }
      },
      {
        name: 'railway_create_service',
        description: 'Create a new service in a Railway project from a GitHub repo',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Railway API token' },
            projectId: { type: 'string', description: 'Project ID' },
            environmentId: { type: 'string', description: 'Environment ID' },
            repoUrl: { type: 'string', description: 'GitHub repository URL' },
            branch: { type: 'string', description: 'Branch name (default: main)' }
          },
          required: ['token', 'projectId', 'environmentId', 'repoUrl']
        }
      },
      {
        name: 'railway_deploy',
        description: 'Deploy a Railway service',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Railway API token' },
            serviceId: { type: 'string', description: 'Service ID' },
            environmentId: { type: 'string', description: 'Environment ID' }
          },
          required: ['token', 'serviceId', 'environmentId']
        }
      },
      {
        name: 'railway_generate_domain',
        description: 'Generate a public domain for a Railway service',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Railway API token' },
            serviceId: { type: 'string', description: 'Service ID' },
            environmentId: { type: 'string', description: 'Environment ID' }
          },
          required: ['token', 'serviceId', 'environmentId']
        }
      },
      {
        name: 'railway_set_variables',
        description: 'Set environment variables for a Railway service',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Railway API token' },
            serviceId: { type: 'string', description: 'Service ID' },
            environmentId: { type: 'string', description: 'Environment ID' },
            variables: { type: 'object', description: 'Key-value pairs of environment variables' }
          },
          required: ['token', 'serviceId', 'environmentId', 'variables']
        }
      },
      {
        name: 'railway_get_deployments',
        description: 'Get deployments for a Railway project',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Railway API token' },
            projectId: { type: 'string', description: 'Project ID' }
          },
          required: ['token', 'projectId']
        }
      },
      // Supabase Tools
      {
        name: 'supabase_list_projects',
        description: 'List all Supabase projects',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Supabase access token' }
          },
          required: ['token']
        }
      },
      {
        name: 'supabase_get_project',
        description: 'Get details of a specific Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Supabase access token' },
            projectRef: { type: 'string', description: 'Project reference ID' }
          },
          required: ['token', 'projectRef']
        }
      },
      {
        name: 'supabase_create_project',
        description: 'Create a new Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Supabase access token' },
            name: { type: 'string', description: 'Project name' },
            organizationId: { type: 'string', description: 'Organization ID' },
            dbPassword: { type: 'string', description: 'Database password' },
            region: { type: 'string', description: 'Region (default: us-east-1)' }
          },
          required: ['token', 'name', 'organizationId', 'dbPassword']
        }
      },
      {
        name: 'supabase_list_organizations',
        description: 'List all Supabase organizations',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Supabase access token' }
          },
          required: ['token']
        }
      },
      {
        name: 'supabase_run_sql',
        description: 'Run SQL query on a Supabase project database',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Supabase access token' },
            projectRef: { type: 'string', description: 'Project reference ID' },
            sql: { type: 'string', description: 'SQL query to execute' }
          },
          required: ['token', 'projectRef', 'sql']
        }
      },
      {
        name: 'supabase_list_tables',
        description: 'List all tables in a Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Supabase access token' },
            projectRef: { type: 'string', description: 'Project reference ID' }
          },
          required: ['token', 'projectRef']
        }
      },
      {
        name: 'supabase_create_table',
        description: 'Create a new table in a Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Supabase access token' },
            projectRef: { type: 'string', description: 'Project reference ID' },
            tableName: { type: 'string', description: 'Table name' },
            columns: {
              type: 'array',
              description: 'Array of column definitions',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  primaryKey: { type: 'boolean' },
                  notNull: { type: 'boolean' },
                  default: { type: 'string' }
                },
                required: ['name', 'type']
              }
            }
          },
          required: ['token', 'projectRef', 'tableName', 'columns']
        }
      }
    ]
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;

      switch (name) {
        // Railway tools
        case 'railway_list_projects':
          result = await railwayGetProjects(args.token);
          break;
        case 'railway_create_project':
          result = await railwayCreateProject(args.token, args.name, args.description);
          break;
        case 'railway_create_service':
          result = await railwayCreateService(args.token, args.projectId, args.environmentId, args.repoUrl, args.branch);
          break;
        case 'railway_deploy':
          result = await railwayDeploy(args.token, args.serviceId, args.environmentId);
          break;
        case 'railway_generate_domain':
          result = await railwayGenerateDomain(args.token, args.serviceId, args.environmentId);
          break;
        case 'railway_set_variables':
          result = await railwaySetVariables(args.token, args.serviceId, args.environmentId, args.variables);
          break;
        case 'railway_get_deployments':
          result = await railwayGetDeployments(args.token, args.projectId);
          break;

        // Supabase tools
        case 'supabase_list_projects':
          result = await supabaseGetProjects(args.token);
          break;
        case 'supabase_get_project':
          result = await supabaseGetProject(args.token, args.projectRef);
          break;
        case 'supabase_create_project':
          result = await supabaseCreateProject(args.token, args.name, args.organizationId, args.dbPassword, args.region);
          break;
        case 'supabase_list_organizations':
          result = await supabaseGetOrganizations(args.token);
          break;
        case 'supabase_run_sql':
          result = await supabaseRunSQL(args.token, args.projectRef, args.sql);
          break;
        case 'supabase_list_tables':
          result = await supabaseGetTables(args.token, args.projectRef);
          break;
        case 'supabase_create_table':
          result = await supabaseCreateTable(args.token, args.projectRef, args.tableName, args.columns);
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      };
    }
  });

  return server;
}

// ============================================
// HTTP/SSE TRANSPORT
// ============================================

// Store active transports
const transports = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SSE endpoint for MCP
app.get('/sse', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const transport = new SSEServerTransport('/messages', res);
  const server = createMCPServer();

  const sessionId = Math.random().toString(36).substring(7);
  transports.set(sessionId, { transport, server });

  res.on('close', () => {
    transports.delete(sessionId);
  });

  await server.connect(transport);
});

// Messages endpoint for MCP
app.post('/messages', async (req, res) => {
  // Find the transport that matches this session
  for (const [, { transport }] of transports) {
    try {
      await transport.handlePostMessage(req, res);
      return;
    } catch {
      // Try next transport
    }
  }
  res.status(404).json({ error: 'No active session' });
});

// MCP info endpoint
app.get('/mcp', (req, res) => {
  res.json({
    name: 'vocal-bridge-mcp',
    version: '1.0.0',
    description: 'MCP server for Railway and Supabase operations',
    endpoints: {
      sse: '/sse',
      messages: '/messages'
    },
    tools: [
      'railway_list_projects',
      'railway_create_project',
      'railway_create_service',
      'railway_deploy',
      'railway_generate_domain',
      'railway_set_variables',
      'railway_get_deployments',
      'supabase_list_projects',
      'supabase_get_project',
      'supabase_create_project',
      'supabase_list_organizations',
      'supabase_run_sql',
      'supabase_list_tables',
      'supabase_create_table'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Messages endpoint: http://localhost:${PORT}/messages`);
  console.log(`Info endpoint: http://localhost:${PORT}/mcp`);
});
