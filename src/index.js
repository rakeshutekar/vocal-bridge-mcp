import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// API Tokens from environment variables (set these in Railway dashboard)
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || '';
const SUPABASE_TOKEN = process.env.SUPABASE_TOKEN || '';

// Railway API configuration
const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

// Supabase API configuration
const SUPABASE_API_URL = 'https://api.supabase.com/v1';

// ============================================
// RAILWAY API FUNCTIONS
// ============================================

async function railwayGraphQL(query, variables = {}) {
  if (!RAILWAY_TOKEN) {
    throw new Error('RAILWAY_TOKEN environment variable is not set');
  }
  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RAILWAY_TOKEN}`,
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

async function railwayGetProjects() {
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
  const data = await railwayGraphQL(query);
  return data.me.projects.edges.map(e => ({
    ...e.node,
    environments: e.node.environments.edges.map(env => env.node),
    services: e.node.services.edges.map(svc => svc.node)
  }));
}

async function railwayCreateProject(name, description = '') {
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
  const data = await railwayGraphQL(query, { input: { name, description } });
  return {
    ...data.projectCreate,
    environments: data.projectCreate.environments.edges.map(e => e.node)
  };
}

async function railwayCreateService(projectId, environmentId, repoUrl, branch = 'main') {
  const query = `
    mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
      }
    }
  `;
  const data = await railwayGraphQL(query, {
    input: { projectId, source: { repo: repoUrl }, branch }
  });
  return data.serviceCreate;
}

async function railwayDeploy(serviceId, environmentId) {
  const query = `
    mutation($input: ServiceInstanceDeployInput!) {
      serviceInstanceDeploy(input: $input)
    }
  `;
  const data = await railwayGraphQL(query, { input: { serviceId, environmentId } });
  return { success: true, deploymentId: data.serviceInstanceDeploy };
}

async function railwayGenerateDomain(serviceId, environmentId) {
  const query = `
    mutation($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        id
        domain
      }
    }
  `;
  const data = await railwayGraphQL(query, { input: { serviceId, environmentId } });
  return data.serviceDomainCreate;
}

async function railwaySetVariables(serviceId, environmentId, variables) {
  const query = `
    mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;
  await railwayGraphQL(query, { input: { serviceId, environmentId, variables } });
  return { success: true };
}

async function railwayGetDeployments(projectId) {
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
  const data = await railwayGraphQL(query, { projectId });
  return data.deployments.edges.map(e => e.node);
}

// ============================================
// SUPABASE API FUNCTIONS
// ============================================

async function supabaseRequest(endpoint, method = 'GET', body = null) {
  if (!SUPABASE_TOKEN) {
    throw new Error('SUPABASE_TOKEN environment variable is not set');
  }
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${SUPABASE_TOKEN}`,
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

async function supabaseGetProjects() {
  return supabaseRequest('/projects');
}

async function supabaseGetProject(projectRef) {
  return supabaseRequest(`/projects/${projectRef}`);
}

async function supabaseCreateProject(name, organizationId, dbPassword, region = 'us-east-1') {
  return supabaseRequest('/projects', 'POST', {
    name,
    organization_id: organizationId,
    db_pass: dbPassword,
    region,
    plan: 'free'
  });
}

async function supabaseGetOrganizations() {
  return supabaseRequest('/organizations');
}

async function supabaseRunSQL(projectRef, sql) {
  return supabaseRequest(`/projects/${projectRef}/database/query`, 'POST', { query: sql });
}

async function supabaseGetTables(projectRef) {
  const sql = `
    SELECT table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `;
  return supabaseRunSQL(projectRef, sql);
}

async function supabaseCreateTable(projectRef, tableName, columns) {
  const columnDefs = columns.map(col =>
    `${col.name} ${col.type}${col.primaryKey ? ' PRIMARY KEY' : ''}${col.notNull ? ' NOT NULL' : ''}${col.default ? ` DEFAULT ${col.default}` : ''}`
  ).join(', ');
  const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs});`;
  return supabaseRunSQL(projectRef, sql);
}

// ============================================
// MCP SERVER SETUP
// ============================================

function createMCPServer() {
  const server = new Server(
    { name: 'vocal-bridge-mcp', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // Railway Tools
      {
        name: 'railway_list_projects',
        description: 'List all Railway projects for the authenticated user',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'railway_create_project',
        description: 'Create a new Railway project',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name' },
            description: { type: 'string', description: 'Project description' }
          },
          required: ['name']
        }
      },
      {
        name: 'railway_create_service',
        description: 'Create a new service in a Railway project from a GitHub repo',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project ID' },
            environmentId: { type: 'string', description: 'Environment ID' },
            repoUrl: { type: 'string', description: 'GitHub repository URL' },
            branch: { type: 'string', description: 'Branch name (default: main)' }
          },
          required: ['projectId', 'environmentId', 'repoUrl']
        }
      },
      {
        name: 'railway_deploy',
        description: 'Deploy a Railway service',
        inputSchema: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', description: 'Service ID' },
            environmentId: { type: 'string', description: 'Environment ID' }
          },
          required: ['serviceId', 'environmentId']
        }
      },
      {
        name: 'railway_generate_domain',
        description: 'Generate a public domain for a Railway service',
        inputSchema: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', description: 'Service ID' },
            environmentId: { type: 'string', description: 'Environment ID' }
          },
          required: ['serviceId', 'environmentId']
        }
      },
      {
        name: 'railway_set_variables',
        description: 'Set environment variables for a Railway service',
        inputSchema: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', description: 'Service ID' },
            environmentId: { type: 'string', description: 'Environment ID' },
            variables: { type: 'object', description: 'Key-value pairs of environment variables' }
          },
          required: ['serviceId', 'environmentId', 'variables']
        }
      },
      {
        name: 'railway_get_deployments',
        description: 'Get deployments for a Railway project',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project ID' }
          },
          required: ['projectId']
        }
      },
      // Supabase Tools
      {
        name: 'supabase_list_projects',
        description: 'List all Supabase projects',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'supabase_get_project',
        description: 'Get details of a specific Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
            projectRef: { type: 'string', description: 'Project reference ID' }
          },
          required: ['projectRef']
        }
      },
      {
        name: 'supabase_create_project',
        description: 'Create a new Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name' },
            organizationId: { type: 'string', description: 'Organization ID' },
            dbPassword: { type: 'string', description: 'Database password' },
            region: { type: 'string', description: 'Region (default: us-east-1)' }
          },
          required: ['name', 'organizationId', 'dbPassword']
        }
      },
      {
        name: 'supabase_list_organizations',
        description: 'List all Supabase organizations',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'supabase_run_sql',
        description: 'Run SQL query on a Supabase project database',
        inputSchema: {
          type: 'object',
          properties: {
            projectRef: { type: 'string', description: 'Project reference ID' },
            sql: { type: 'string', description: 'SQL query to execute' }
          },
          required: ['projectRef', 'sql']
        }
      },
      {
        name: 'supabase_list_tables',
        description: 'List all tables in a Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
            projectRef: { type: 'string', description: 'Project reference ID' }
          },
          required: ['projectRef']
        }
      },
      {
        name: 'supabase_create_table',
        description: 'Create a new table in a Supabase project',
        inputSchema: {
          type: 'object',
          properties: {
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
          required: ['projectRef', 'tableName', 'columns']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;

      switch (name) {
        // Railway tools
        case 'railway_list_projects':
          result = await railwayGetProjects();
          break;
        case 'railway_create_project':
          result = await railwayCreateProject(args.name, args.description);
          break;
        case 'railway_create_service':
          result = await railwayCreateService(args.projectId, args.environmentId, args.repoUrl, args.branch);
          break;
        case 'railway_deploy':
          result = await railwayDeploy(args.serviceId, args.environmentId);
          break;
        case 'railway_generate_domain':
          result = await railwayGenerateDomain(args.serviceId, args.environmentId);
          break;
        case 'railway_set_variables':
          result = await railwaySetVariables(args.serviceId, args.environmentId, args.variables);
          break;
        case 'railway_get_deployments':
          result = await railwayGetDeployments(args.projectId);
          break;

        // Supabase tools
        case 'supabase_list_projects':
          result = await supabaseGetProjects();
          break;
        case 'supabase_get_project':
          result = await supabaseGetProject(args.projectRef);
          break;
        case 'supabase_create_project':
          result = await supabaseCreateProject(args.name, args.organizationId, args.dbPassword, args.region);
          break;
        case 'supabase_list_organizations':
          result = await supabaseGetOrganizations();
          break;
        case 'supabase_run_sql':
          result = await supabaseRunSQL(args.projectRef, args.sql);
          break;
        case 'supabase_list_tables':
          result = await supabaseGetTables(args.projectRef);
          break;
        case 'supabase_create_table':
          result = await supabaseCreateTable(args.projectRef, args.tableName, args.columns);
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
// STREAMABLE HTTP TRANSPORT
// ============================================

const sessions = new Map();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    railwayTokenConfigured: !!RAILWAY_TOKEN,
    supabaseTokenConfigured: !!SUPABASE_TOKEN
  });
});

app.get('/mcp', (req, res) => {
  res.json({
    name: 'vocal-bridge-mcp',
    version: '2.0.0',
    description: 'MCP server for Railway and Supabase operations',
    transport: 'streamable-http',
    endpoint: '/mcp',
    railwayTokenConfigured: !!RAILWAY_TOKEN,
    supabaseTokenConfigured: !!SUPABASE_TOKEN,
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

app.post('/mcp', async (req, res) => {
  try {
    let sessionId = req.headers['mcp-session-id'];
    let transport;
    let server;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      transport = session.transport;
      server = session.server;
    } else {
      sessionId = randomUUID();
      server = createMCPServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        }
      });
      await server.connect(transport);
      sessions.set(sessionId, { transport, server });
    }

    res.setHeader('Mcp-Session-Id', sessionId);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    res.status(200).json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Vocal Bridge MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Railway token configured: ${!!RAILWAY_TOKEN}`);
  console.log(`Supabase token configured: ${!!SUPABASE_TOKEN}`);
});
