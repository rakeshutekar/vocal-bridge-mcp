import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;

// API Tokens - read dynamically to support hot-reload of env vars
function getRailwayToken() {
  return process.env.RAILWAY_TOKEN || '';
}

function getSupabaseToken() {
  return process.env.SUPABASE_TOKEN || '';
}

// Workspace directory for filesystem operations
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/tmp/workspace';

// Initialize workspace directory
await fs.mkdir(WORKSPACE_DIR, { recursive: true });

// Initialize SQLite database for memory
const DB_PATH = process.env.DB_PATH || '/tmp/memory.db';
const db = new Database(DB_PATH);

// Create memory tables
db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    from_entity TEXT NOT NULL,
    to_entity TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_entity) REFERENCES entities(id),
    FOREIGN KEY (to_entity) REFERENCES entities(id)
  );

  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
  CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
  CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
`);

// Railway API configuration
const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

// Supabase API configuration
const SUPABASE_API_URL = 'https://api.supabase.com/v1';

// ============================================
// FILESYSTEM FUNCTIONS
// ============================================

function resolvePath(filePath) {
  const resolved = path.resolve(WORKSPACE_DIR, filePath);
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error('Access denied: Path is outside workspace');
  }
  return resolved;
}

async function writeFile(filePath, content) {
  const fullPath = resolvePath(filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
  return { success: true, path: filePath, size: content.length };
}

async function readFile(filePath) {
  const fullPath = resolvePath(filePath);
  const content = await fs.readFile(fullPath, 'utf-8');
  const stats = await fs.stat(fullPath);
  return { content, path: filePath, size: stats.size };
}

async function editFile(filePath, oldText, newText) {
  const fullPath = resolvePath(filePath);
  let content = await fs.readFile(fullPath, 'utf-8');
  if (!content.includes(oldText)) {
    throw new Error('Old text not found in file');
  }
  content = content.replace(oldText, newText);
  await fs.writeFile(fullPath, content, 'utf-8');
  return { success: true, path: filePath };
}

async function deleteFile(filePath) {
  const fullPath = resolvePath(filePath);
  await fs.unlink(fullPath);
  return { success: true, path: filePath };
}

async function createDirectory(dirPath) {
  const fullPath = resolvePath(dirPath);
  await fs.mkdir(fullPath, { recursive: true });
  return { success: true, path: dirPath };
}

async function listDirectory(dirPath = '.') {
  const fullPath = resolvePath(dirPath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (entry) => {
    const itemPath = path.join(fullPath, entry.name);
    const stats = await fs.stat(itemPath);
    return {
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      modified: stats.mtime.toISOString()
    };
  }));
  return { path: dirPath, items };
}

async function getDirectoryTree(dirPath = '.', maxDepth = 3) {
  const fullPath = resolvePath(dirPath);

  async function buildTree(currentPath, depth) {
    if (depth > maxDepth) return null;

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      const item = { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' };
      if (entry.isDirectory() && depth < maxDepth) {
        item.children = await buildTree(path.join(currentPath, entry.name), depth + 1);
      }
      items.push(item);
    }
    return items;
  }

  return { path: dirPath, tree: await buildTree(fullPath, 0) };
}

// ============================================
// MEMORY FUNCTIONS
// ============================================

function memoryStore(name, type, content, metadata = {}) {
  const id = randomUUID();
  const stmt = db.prepare(`
    INSERT INTO entities (id, name, type, content, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, name, type, content, JSON.stringify(metadata));
  return { id, name, type, created: true };
}

function memoryUpdate(id, content, metadata = null) {
  const updates = ['content = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [content];

  if (metadata !== null) {
    updates.push('metadata = ?');
    params.push(JSON.stringify(metadata));
  }

  params.push(id);
  const stmt = db.prepare(`UPDATE entities SET ${updates.join(', ')} WHERE id = ?`);
  const result = stmt.run(...params);
  return { id, updated: result.changes > 0 };
}

function memoryRecall(nameOrId) {
  const stmt = db.prepare(`
    SELECT * FROM entities WHERE id = ? OR name = ?
  `);
  const entity = stmt.get(nameOrId, nameOrId);
  if (!entity) return { found: false };

  return {
    found: true,
    id: entity.id,
    name: entity.name,
    type: entity.type,
    content: entity.content,
    metadata: JSON.parse(entity.metadata || '{}'),
    created_at: entity.created_at,
    updated_at: entity.updated_at
  };
}

function memorySearch(query, type = null) {
  let sql = `SELECT * FROM entities WHERE (name LIKE ? OR content LIKE ?)`;
  const params = [`%${query}%`, `%${query}%`];

  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY updated_at DESC LIMIT 50`;

  const stmt = db.prepare(sql);
  const entities = stmt.all(...params);

  return {
    count: entities.length,
    entities: entities.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      content: e.content?.substring(0, 200) + (e.content?.length > 200 ? '...' : ''),
      updated_at: e.updated_at
    }))
  };
}

function memoryList(type = null, limit = 50) {
  let sql = `SELECT * FROM entities`;
  const params = [];

  if (type) {
    sql += ` WHERE type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(sql);
  const entities = stmt.all(...params);

  return {
    count: entities.length,
    entities: entities.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      updated_at: e.updated_at
    }))
  };
}

function memoryDelete(id) {
  const stmt = db.prepare(`DELETE FROM entities WHERE id = ?`);
  const result = stmt.run(id);
  return { deleted: result.changes > 0 };
}

function memoryRelate(fromId, toId, relationType, metadata = {}) {
  const id = randomUUID();
  const stmt = db.prepare(`
    INSERT INTO relations (id, from_entity, to_entity, relation_type, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, fromId, toId, relationType, JSON.stringify(metadata));
  return { id, created: true };
}

function memoryGetRelations(entityId) {
  const stmt = db.prepare(`
    SELECT r.*,
           e1.name as from_name, e1.type as from_type,
           e2.name as to_name, e2.type as to_type
    FROM relations r
    LEFT JOIN entities e1 ON r.from_entity = e1.id
    LEFT JOIN entities e2 ON r.to_entity = e2.id
    WHERE r.from_entity = ? OR r.to_entity = ?
  `);
  const relations = stmt.all(entityId, entityId);
  return { count: relations.length, relations };
}

// ============================================
// RAILWAY API FUNCTIONS
// ============================================

async function railwayGraphQL(query, variables = {}) {
  const railwayToken = getRailwayToken();
  if (!railwayToken) {
    throw new Error('RAILWAY_TOKEN environment variable is not set');
  }
  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${railwayToken}`,
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
  const supabaseToken = getSupabaseToken();
  if (!supabaseToken) {
    throw new Error('SUPABASE_TOKEN environment variable is not set');
  }
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${supabaseToken}`,
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
      // ========== FILESYSTEM TOOLS ==========
      {
        name: 'fs_write_file',
        description: 'Write content to a file in the workspace. Creates directories if needed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' },
            content: { type: 'string', description: 'Content to write' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'fs_read_file',
        description: 'Read content from a file in the workspace',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' }
          },
          required: ['path']
        }
      },
      {
        name: 'fs_edit_file',
        description: 'Edit a file by replacing text',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' },
            old_text: { type: 'string', description: 'Text to find and replace' },
            new_text: { type: 'string', description: 'Replacement text' }
          },
          required: ['path', 'old_text', 'new_text']
        }
      },
      {
        name: 'fs_delete_file',
        description: 'Delete a file from the workspace',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' }
          },
          required: ['path']
        }
      },
      {
        name: 'fs_create_directory',
        description: 'Create a directory in the workspace',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path relative to workspace' }
          },
          required: ['path']
        }
      },
      {
        name: 'fs_list_directory',
        description: 'List contents of a directory',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (default: workspace root)' }
          },
          required: []
        }
      },
      {
        name: 'fs_directory_tree',
        description: 'Get directory tree structure',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (default: workspace root)' },
            max_depth: { type: 'number', description: 'Maximum depth (default: 3)' }
          },
          required: []
        }
      },

      // ========== MEMORY TOOLS ==========
      {
        name: 'memory_store',
        description: 'Store information in persistent memory',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name/identifier for the memory' },
            type: { type: 'string', description: 'Type category (e.g., "project", "schema", "config", "code")' },
            content: { type: 'string', description: 'Content to store' },
            metadata: { type: 'object', description: 'Optional metadata' }
          },
          required: ['name', 'type', 'content']
        }
      },
      {
        name: 'memory_update',
        description: 'Update existing memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Memory ID to update' },
            content: { type: 'string', description: 'New content' },
            metadata: { type: 'object', description: 'Optional new metadata' }
          },
          required: ['id', 'content']
        }
      },
      {
        name: 'memory_recall',
        description: 'Recall a specific memory by name or ID',
        inputSchema: {
          type: 'object',
          properties: {
            name_or_id: { type: 'string', description: 'Name or ID of the memory' }
          },
          required: ['name_or_id']
        }
      },
      {
        name: 'memory_search',
        description: 'Search memories by query',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            type: { type: 'string', description: 'Optional type filter' }
          },
          required: ['query']
        }
      },
      {
        name: 'memory_list',
        description: 'List all memories, optionally filtered by type',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Optional type filter' },
            limit: { type: 'number', description: 'Max results (default: 50)' }
          },
          required: []
        }
      },
      {
        name: 'memory_delete',
        description: 'Delete a memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Memory ID to delete' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_relate',
        description: 'Create a relationship between two memories',
        inputSchema: {
          type: 'object',
          properties: {
            from_id: { type: 'string', description: 'Source memory ID' },
            to_id: { type: 'string', description: 'Target memory ID' },
            relation_type: { type: 'string', description: 'Type of relation (e.g., "depends_on", "part_of")' },
            metadata: { type: 'object', description: 'Optional metadata' }
          },
          required: ['from_id', 'to_id', 'relation_type']
        }
      },
      {
        name: 'memory_get_relations',
        description: 'Get all relations for a memory',
        inputSchema: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', description: 'Memory ID' }
          },
          required: ['entity_id']
        }
      },

      // ========== RAILWAY TOOLS ==========
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

      // ========== SUPABASE TOOLS ==========
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
        // Filesystem tools
        case 'fs_write_file':
          result = await writeFile(args.path, args.content);
          break;
        case 'fs_read_file':
          result = await readFile(args.path);
          break;
        case 'fs_edit_file':
          result = await editFile(args.path, args.old_text, args.new_text);
          break;
        case 'fs_delete_file':
          result = await deleteFile(args.path);
          break;
        case 'fs_create_directory':
          result = await createDirectory(args.path);
          break;
        case 'fs_list_directory':
          result = await listDirectory(args.path || '.');
          break;
        case 'fs_directory_tree':
          result = await getDirectoryTree(args.path || '.', args.max_depth || 3);
          break;

        // Memory tools
        case 'memory_store':
          result = memoryStore(args.name, args.type, args.content, args.metadata || {});
          break;
        case 'memory_update':
          result = memoryUpdate(args.id, args.content, args.metadata);
          break;
        case 'memory_recall':
          result = memoryRecall(args.name_or_id);
          break;
        case 'memory_search':
          result = memorySearch(args.query, args.type);
          break;
        case 'memory_list':
          result = memoryList(args.type, args.limit || 50);
          break;
        case 'memory_delete':
          result = memoryDelete(args.id);
          break;
        case 'memory_relate':
          result = memoryRelate(args.from_id, args.to_id, args.relation_type, args.metadata || {});
          break;
        case 'memory_get_relations':
          result = memoryGetRelations(args.entity_id);
          break;

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
    railwayTokenConfigured: !!getRailwayToken(),
    supabaseTokenConfigured: !!getSupabaseToken(),
    workspaceDir: WORKSPACE_DIR,
    dbPath: DB_PATH
  });
});

app.get('/mcp', (req, res) => {
  res.json({
    name: 'vocal-bridge-mcp',
    version: '2.0.0',
    description: 'MCP server for Railway, Supabase, Filesystem, and Memory operations',
    transport: 'streamable-http',
    endpoint: '/mcp',
    capabilities: {
      filesystem: true,
      memory: true,
      railway: !!getRailwayToken(),
      supabase: !!getSupabaseToken()
    },
    tools: {
      filesystem: ['fs_write_file', 'fs_read_file', 'fs_edit_file', 'fs_delete_file', 'fs_create_directory', 'fs_list_directory', 'fs_directory_tree'],
      memory: ['memory_store', 'memory_update', 'memory_recall', 'memory_search', 'memory_list', 'memory_delete', 'memory_relate', 'memory_get_relations'],
      railway: ['railway_list_projects', 'railway_create_project', 'railway_create_service', 'railway_deploy', 'railway_generate_domain', 'railway_set_variables', 'railway_get_deployments'],
      supabase: ['supabase_list_projects', 'supabase_get_project', 'supabase_create_project', 'supabase_list_organizations', 'supabase_run_sql', 'supabase_list_tables', 'supabase_create_table']
    }
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
  console.log(`Vocal Bridge MCP Server v2.0.0 running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Railway token configured: ${!!getRailwayToken()}`);
  console.log(`Supabase token configured: ${!!getSupabaseToken()}`);
  console.log(`Workspace directory: ${WORKSPACE_DIR}`);
  console.log(`Database path: ${DB_PATH}`);
});
