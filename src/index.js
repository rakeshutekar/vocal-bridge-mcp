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

// Railway API configuration
const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

// Supabase API configuration
const SUPABASE_API_URL = 'https://api.supabase.com/v1';

// GitHub API configuration
const GITHUB_API_URL = 'https://api.github.com';

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
// GITHUB API FUNCTIONS
// ============================================

async function githubRequest(token, endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${GITHUB_API_URL}${endpoint}`, options);

  // Handle 204 No Content
  if (response.status === 204) {
    return { success: true };
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `GitHub API error: ${response.status}`);
  }

  return response.json();
}

async function githubGetUser(token) {
  return githubRequest(token, '/user');
}

async function githubVerifyToken(token) {
  try {
    const user = await githubGetUser(token);
    return {
      valid: true,
      user: {
        login: user.login,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url
      }
    };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

async function githubListRepositories(token, sort = 'updated', perPage = 30) {
  return githubRequest(token, `/user/repos?sort=${sort}&per_page=${perPage}`);
}

async function githubGetRepository(token, owner, repo) {
  return githubRequest(token, `/repos/${owner}/${repo}`);
}

async function githubCreateRepository(token, name, description = '', isPrivate = false, autoInit = true) {
  return githubRequest(token, '/user/repos', 'POST', {
    name,
    description,
    private: isPrivate,
    auto_init: autoInit
  });
}

async function githubDeleteRepository(token, owner, repo) {
  return githubRequest(token, `/repos/${owner}/${repo}`, 'DELETE');
}

async function githubGetFileContents(token, owner, repo, path, ref = 'main') {
  const data = await githubRequest(token, `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);

  // Decode base64 content if it's a file
  if (data.content && data.encoding === 'base64') {
    data.decodedContent = Buffer.from(data.content, 'base64').toString('utf-8');
  }

  return data;
}

async function githubCreateOrUpdateFile(token, owner, repo, path, content, message, branch = 'main', sha = null) {
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch
  };

  if (sha) {
    body.sha = sha;
  }

  return githubRequest(token, `/repos/${owner}/${repo}/contents/${path}`, 'PUT', body);
}

async function githubDeleteFile(token, owner, repo, path, message, sha, branch = 'main') {
  return githubRequest(token, `/repos/${owner}/${repo}/contents/${path}`, 'DELETE', {
    message,
    sha,
    branch
  });
}

async function githubPushFiles(token, owner, repo, files, message, branch = 'main') {
  // 1. Get the current commit SHA for the branch
  const refData = await githubRequest(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const currentCommitSha = refData.object.sha;

  // 2. Get the tree SHA from the current commit
  const commitData = await githubRequest(token, `/repos/${owner}/${repo}/git/commits/${currentCommitSha}`);
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async (file) => {
      const blobData = await githubRequest(token, `/repos/${owner}/${repo}/git/blobs`, 'POST', {
        content: file.content,
        encoding: 'utf-8'
      });

      return {
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha
      };
    })
  );

  // 4. Create a new tree
  const newTree = await githubRequest(token, `/repos/${owner}/${repo}/git/trees`, 'POST', {
    base_tree: baseTreeSha,
    tree: treeItems
  });

  // 5. Create a new commit
  const newCommit = await githubRequest(token, `/repos/${owner}/${repo}/git/commits`, 'POST', {
    message,
    tree: newTree.sha,
    parents: [currentCommitSha]
  });

  // 6. Update the branch reference
  await githubRequest(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', {
    sha: newCommit.sha
  });

  return {
    commit: newCommit,
    filesUpdated: files.length
  };
}

async function githubListBranches(token, owner, repo) {
  return githubRequest(token, `/repos/${owner}/${repo}/branches`);
}

async function githubGetBranch(token, owner, repo, branch) {
  return githubRequest(token, `/repos/${owner}/${repo}/branches/${branch}`);
}

async function githubCreateBranch(token, owner, repo, branchName, fromBranch = 'main') {
  // Get the SHA of the source branch
  const sourceBranch = await githubGetBranch(token, owner, repo, fromBranch);
  const sha = sourceBranch.commit.sha;

  return githubRequest(token, `/repos/${owner}/${repo}/git/refs`, 'POST', {
    ref: `refs/heads/${branchName}`,
    sha
  });
}

async function githubDeleteBranch(token, owner, repo, branch) {
  return githubRequest(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'DELETE');
}

async function githubListCommits(token, owner, repo, branch = 'main', perPage = 30) {
  return githubRequest(token, `/repos/${owner}/${repo}/commits?sha=${branch}&per_page=${perPage}`);
}

async function githubGetCommit(token, owner, repo, sha) {
  return githubRequest(token, `/repos/${owner}/${repo}/commits/${sha}`);
}

async function githubCreatePullRequest(token, owner, repo, title, head, base, body = '', draft = false) {
  return githubRequest(token, `/repos/${owner}/${repo}/pulls`, 'POST', {
    title,
    head,
    base,
    body,
    draft
  });
}

async function githubListPullRequests(token, owner, repo, state = 'open', perPage = 30) {
  return githubRequest(token, `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`);
}

async function githubGetPullRequest(token, owner, repo, pullNumber) {
  return githubRequest(token, `/repos/${owner}/${repo}/pulls/${pullNumber}`);
}

async function githubMergePullRequest(token, owner, repo, pullNumber, commitTitle = '', commitMessage = '', mergeMethod = 'merge') {
  return githubRequest(token, `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, 'PUT', {
    commit_title: commitTitle,
    commit_message: commitMessage,
    merge_method: mergeMethod
  });
}

async function githubCreateIssue(token, owner, repo, title, body = '', labels = [], assignees = []) {
  return githubRequest(token, `/repos/${owner}/${repo}/issues`, 'POST', {
    title,
    body,
    labels,
    assignees
  });
}

async function githubListIssues(token, owner, repo, state = 'open', perPage = 30) {
  return githubRequest(token, `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}`);
}

async function githubAddComment(token, owner, repo, issueNumber, body) {
  return githubRequest(token, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, 'POST', { body });
}

async function githubGetTree(token, owner, repo, sha = 'main', recursive = true) {
  const params = recursive ? '?recursive=1' : '';
  return githubRequest(token, `/repos/${owner}/${repo}/git/trees/${sha}${params}`);
}

async function githubListContents(token, owner, repo, path = '', ref = 'main') {
  const endpoint = path
    ? `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`
    : `/repos/${owner}/${repo}/contents?ref=${ref}`;
  return githubRequest(token, endpoint);
}

async function githubSearchRepositories(token, query, sort = 'stars', order = 'desc', perPage = 10) {
  const params = new URLSearchParams({
    q: query,
    sort,
    order,
    per_page: perPage.toString()
  });
  return githubRequest(token, `/search/repositories?${params}`);
}

async function githubSearchCode(token, query, perPage = 30) {
  const params = new URLSearchParams({
    q: query,
    per_page: perPage.toString()
  });
  return githubRequest(token, `/search/code?${params}`);
}

// ============================================
// MCP SERVER SETUP
// ============================================

function createMCPServer() {
  const server = new Server(
    { name: 'vocal-bridge-mcp', version: '1.1.0' },
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
      },
      // GitHub Tools
      {
        name: 'github_verify_token',
        description: 'Verify GitHub access token and get user info',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' }
          },
          required: ['token']
        }
      },
      {
        name: 'github_get_user',
        description: 'Get authenticated GitHub user info',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' }
          },
          required: ['token']
        }
      },
      {
        name: 'github_list_repositories',
        description: 'List repositories for the authenticated user',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            sort: { type: 'string', description: 'Sort by: created, updated, pushed, full_name (default: updated)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['token']
        }
      },
      {
        name: 'github_get_repository',
        description: 'Get repository details',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_create_repository',
        description: 'Create a new GitHub repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            name: { type: 'string', description: 'Repository name' },
            description: { type: 'string', description: 'Repository description' },
            isPrivate: { type: 'boolean', description: 'Make repository private (default: false)' },
            autoInit: { type: 'boolean', description: 'Initialize with README (default: true)' }
          },
          required: ['token', 'name']
        }
      },
      {
        name: 'github_delete_repository',
        description: 'Delete a GitHub repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_get_file_contents',
        description: 'Get contents of a file from a repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path' },
            ref: { type: 'string', description: 'Branch or commit (default: main)' }
          },
          required: ['token', 'owner', 'repo', 'path']
        }
      },
      {
        name: 'github_create_or_update_file',
        description: 'Create or update a file in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' },
            message: { type: 'string', description: 'Commit message' },
            branch: { type: 'string', description: 'Branch name (default: main)' },
            sha: { type: 'string', description: 'SHA of file to update (required for updates)' }
          },
          required: ['token', 'owner', 'repo', 'path', 'content', 'message']
        }
      },
      {
        name: 'github_delete_file',
        description: 'Delete a file from a repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path' },
            message: { type: 'string', description: 'Commit message' },
            sha: { type: 'string', description: 'SHA of file to delete' },
            branch: { type: 'string', description: 'Branch name (default: main)' }
          },
          required: ['token', 'owner', 'repo', 'path', 'message', 'sha']
        }
      },
      {
        name: 'github_push_files',
        description: 'Push multiple files in a single commit using Git Data API',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            files: {
              type: 'array',
              description: 'Array of files to push',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path' },
                  content: { type: 'string', description: 'File content' }
                },
                required: ['path', 'content']
              }
            },
            message: { type: 'string', description: 'Commit message' },
            branch: { type: 'string', description: 'Branch name (default: main)' }
          },
          required: ['token', 'owner', 'repo', 'files', 'message']
        }
      },
      {
        name: 'github_list_branches',
        description: 'List branches in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_create_branch',
        description: 'Create a new branch',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branchName: { type: 'string', description: 'New branch name' },
            fromBranch: { type: 'string', description: 'Source branch (default: main)' }
          },
          required: ['token', 'owner', 'repo', 'branchName']
        }
      },
      {
        name: 'github_delete_branch',
        description: 'Delete a branch',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name to delete' }
          },
          required: ['token', 'owner', 'repo', 'branch']
        }
      },
      {
        name: 'github_list_commits',
        description: 'List commits in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name (default: main)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_get_commit',
        description: 'Get a specific commit',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            sha: { type: 'string', description: 'Commit SHA' }
          },
          required: ['token', 'owner', 'repo', 'sha']
        }
      },
      {
        name: 'github_create_pull_request',
        description: 'Create a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'PR title' },
            head: { type: 'string', description: 'Source branch' },
            base: { type: 'string', description: 'Target branch' },
            body: { type: 'string', description: 'PR description' },
            draft: { type: 'boolean', description: 'Create as draft (default: false)' }
          },
          required: ['token', 'owner', 'repo', 'title', 'head', 'base']
        }
      },
      {
        name: 'github_list_pull_requests',
        description: 'List pull requests',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'State: open, closed, all (default: open)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_get_pull_request',
        description: 'Get a specific pull request',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pullNumber: { type: 'number', description: 'Pull request number' }
          },
          required: ['token', 'owner', 'repo', 'pullNumber']
        }
      },
      {
        name: 'github_merge_pull_request',
        description: 'Merge a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pullNumber: { type: 'number', description: 'Pull request number' },
            commitTitle: { type: 'string', description: 'Merge commit title' },
            commitMessage: { type: 'string', description: 'Merge commit message' },
            mergeMethod: { type: 'string', description: 'Merge method: merge, squash, rebase (default: merge)' }
          },
          required: ['token', 'owner', 'repo', 'pullNumber']
        }
      },
      {
        name: 'github_create_issue',
        description: 'Create an issue',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Labels' },
            assignees: { type: 'array', items: { type: 'string' }, description: 'Assignees' }
          },
          required: ['token', 'owner', 'repo', 'title']
        }
      },
      {
        name: 'github_list_issues',
        description: 'List issues in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'State: open, closed, all (default: open)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_add_comment',
        description: 'Add a comment to an issue or PR',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            issueNumber: { type: 'number', description: 'Issue or PR number' },
            body: { type: 'string', description: 'Comment body' }
          },
          required: ['token', 'owner', 'repo', 'issueNumber', 'body']
        }
      },
      {
        name: 'github_get_tree',
        description: 'Get repository tree (directory structure)',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            sha: { type: 'string', description: 'Tree SHA or branch (default: main)' },
            recursive: { type: 'boolean', description: 'Get tree recursively (default: true)' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_list_contents',
        description: 'List directory contents',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'Directory path (default: root)' },
            ref: { type: 'string', description: 'Branch or commit (default: main)' }
          },
          required: ['token', 'owner', 'repo']
        }
      },
      {
        name: 'github_search_repositories',
        description: 'Search GitHub repositories',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            query: { type: 'string', description: 'Search query' },
            sort: { type: 'string', description: 'Sort by: stars, forks, updated (default: stars)' },
            order: { type: 'string', description: 'Order: asc, desc (default: desc)' },
            perPage: { type: 'number', description: 'Results per page (default: 10)' }
          },
          required: ['token', 'query']
        }
      },
      {
        name: 'github_search_code',
        description: 'Search code across repositories',
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'GitHub personal access token' },
            query: { type: 'string', description: 'Search query' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['token', 'query']
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

        // GitHub tools
        case 'github_verify_token':
          result = await githubVerifyToken(args.token);
          break;
        case 'github_get_user':
          result = await githubGetUser(args.token);
          break;
        case 'github_list_repositories':
          result = await githubListRepositories(args.token, args.sort, args.perPage);
          break;
        case 'github_get_repository':
          result = await githubGetRepository(args.token, args.owner, args.repo);
          break;
        case 'github_create_repository':
          result = await githubCreateRepository(args.token, args.name, args.description, args.isPrivate, args.autoInit);
          break;
        case 'github_delete_repository':
          result = await githubDeleteRepository(args.token, args.owner, args.repo);
          break;
        case 'github_get_file_contents':
          result = await githubGetFileContents(args.token, args.owner, args.repo, args.path, args.ref);
          break;
        case 'github_create_or_update_file':
          result = await githubCreateOrUpdateFile(args.token, args.owner, args.repo, args.path, args.content, args.message, args.branch, args.sha);
          break;
        case 'github_delete_file':
          result = await githubDeleteFile(args.token, args.owner, args.repo, args.path, args.message, args.sha, args.branch);
          break;
        case 'github_push_files':
          result = await githubPushFiles(args.token, args.owner, args.repo, args.files, args.message, args.branch);
          break;
        case 'github_list_branches':
          result = await githubListBranches(args.token, args.owner, args.repo);
          break;
        case 'github_create_branch':
          result = await githubCreateBranch(args.token, args.owner, args.repo, args.branchName, args.fromBranch);
          break;
        case 'github_delete_branch':
          result = await githubDeleteBranch(args.token, args.owner, args.repo, args.branch);
          break;
        case 'github_list_commits':
          result = await githubListCommits(args.token, args.owner, args.repo, args.branch, args.perPage);
          break;
        case 'github_get_commit':
          result = await githubGetCommit(args.token, args.owner, args.repo, args.sha);
          break;
        case 'github_create_pull_request':
          result = await githubCreatePullRequest(args.token, args.owner, args.repo, args.title, args.head, args.base, args.body, args.draft);
          break;
        case 'github_list_pull_requests':
          result = await githubListPullRequests(args.token, args.owner, args.repo, args.state, args.perPage);
          break;
        case 'github_get_pull_request':
          result = await githubGetPullRequest(args.token, args.owner, args.repo, args.pullNumber);
          break;
        case 'github_merge_pull_request':
          result = await githubMergePullRequest(args.token, args.owner, args.repo, args.pullNumber, args.commitTitle, args.commitMessage, args.mergeMethod);
          break;
        case 'github_create_issue':
          result = await githubCreateIssue(args.token, args.owner, args.repo, args.title, args.body, args.labels, args.assignees);
          break;
        case 'github_list_issues':
          result = await githubListIssues(args.token, args.owner, args.repo, args.state, args.perPage);
          break;
        case 'github_add_comment':
          result = await githubAddComment(args.token, args.owner, args.repo, args.issueNumber, args.body);
          break;
        case 'github_get_tree':
          result = await githubGetTree(args.token, args.owner, args.repo, args.sha, args.recursive);
          break;
        case 'github_list_contents':
          result = await githubListContents(args.token, args.owner, args.repo, args.path, args.ref);
          break;
        case 'github_search_repositories':
          result = await githubSearchRepositories(args.token, args.query, args.sort, args.order, args.perPage);
          break;
        case 'github_search_code':
          result = await githubSearchCode(args.token, args.query, args.perPage);
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

// Store active sessions
const sessions = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// MCP info endpoint
app.get('/mcp', (req, res) => {
  res.json({
    name: 'vocal-bridge-mcp',
    version: '1.1.0',
    description: 'MCP server for Railway, Supabase, and GitHub operations',
    transport: 'streamable-http',
    endpoint: '/mcp',
    tools: [
      // Railway tools
      'railway_list_projects',
      'railway_create_project',
      'railway_create_service',
      'railway_deploy',
      'railway_generate_domain',
      'railway_set_variables',
      'railway_get_deployments',
      // Supabase tools
      'supabase_list_projects',
      'supabase_get_project',
      'supabase_create_project',
      'supabase_list_organizations',
      'supabase_run_sql',
      'supabase_list_tables',
      'supabase_create_table',
      // GitHub tools
      'github_verify_token',
      'github_get_user',
      'github_list_repositories',
      'github_get_repository',
      'github_create_repository',
      'github_delete_repository',
      'github_get_file_contents',
      'github_create_or_update_file',
      'github_delete_file',
      'github_push_files',
      'github_list_branches',
      'github_create_branch',
      'github_delete_branch',
      'github_list_commits',
      'github_get_commit',
      'github_create_pull_request',
      'github_list_pull_requests',
      'github_get_pull_request',
      'github_merge_pull_request',
      'github_create_issue',
      'github_list_issues',
      'github_add_comment',
      'github_get_tree',
      'github_list_contents',
      'github_search_repositories',
      'github_search_code'
    ]
  });
});

// Streamable HTTP MCP endpoint - handles POST requests
app.post('/mcp', async (req, res) => {
  try {
    // Get or create session
    let sessionId = req.headers['mcp-session-id'];
    let transport;
    let server;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      transport = session.transport;
      server = session.server;
    } else {
      // Create new session
      sessionId = randomUUID();
      server = createMCPServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        }
      });

      // Connect server to transport
      await server.connect(transport);
      sessions.set(sessionId, { transport, server });
    }

    // Set session ID header
    res.setHeader('Mcp-Session-Id', sessionId);

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle GET requests for SSE streaming (optional, for server-initiated messages)
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }

  const session = sessions.get(sessionId);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Mcp-Session-Id', sessionId);

  // Handle client disconnect
  req.on('close', () => {
    sessions.delete(sessionId);
  });

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// Handle DELETE for session cleanup
app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    res.status(200).json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Legacy SSE endpoint for backwards compatibility
app.get('/sse', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sessionId = randomUUID();
  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`Streamable HTTP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Legacy SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Info endpoint: http://localhost:${PORT}/mcp (GET)`);
  console.log('Available services: Railway, Supabase, GitHub');
});
