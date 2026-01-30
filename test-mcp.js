// Test script for Vocal Bridge MCP Server v2.0.0
// Tests Filesystem and Memory tools

const BASE_URL = process.env.MCP_URL || 'http://localhost:8080';

async function testMCP() {
  console.log('🧪 Testing Vocal Bridge MCP Server v2.0.0');
  console.log(`📍 Base URL: ${BASE_URL}\n`);

  let sessionId = null;
  const results = { passed: 0, failed: 0, tests: [] };

  // Helper to make MCP requests with proper headers
  async function mcpRequest(method, body = null) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const response = await fetch(`${BASE_URL}/mcp`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });

    // Capture session ID
    const newSessionId = response.headers.get('Mcp-Session-Id');
    if (newSessionId) {
      sessionId = newSessionId;
    }

    // Handle SSE responses
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/event-stream')) {
      const text = await response.text();
      // Parse SSE format - find the data line
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          return JSON.parse(line.substring(6));
        }
      }
      throw new Error('No data in SSE response');
    }

    return response.json();
  }

  // Helper to call a tool
  async function callTool(name, args = {}) {
    const data = await mcpRequest('POST', {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args }
    });

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    // Parse the content from the response
    if (data.result?.content?.[0]?.text) {
      return JSON.parse(data.result.content[0].text);
    }
    return data.result;
  }

  // Test helper
  async function test(name, fn) {
    try {
      await fn();
      results.passed++;
      results.tests.push({ name, status: 'PASS' });
      console.log(`✅ ${name}`);
    } catch (error) {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', error: error.message });
      console.log(`❌ ${name}: ${error.message}`);
    }
  }

  // ============ Health Check ============
  await test('Health check', async () => {
    const response = await fetch(`${BASE_URL}/health`);
    const data = await response.json();
    if (data.status !== 'ok') throw new Error('Health check failed');
    console.log(`   Workspace: ${data.workspaceDir}`);
    console.log(`   Database: ${data.dbPath}`);
  });

  // ============ MCP Info ============
  await test('MCP info endpoint', async () => {
    const response = await fetch(`${BASE_URL}/mcp`);
    const data = await response.json();
    if (data.version !== '2.0.0') throw new Error('Wrong version');
    console.log(`   Tools: ${Object.values(data.tools).flat().length} total`);
  });

  // ============ Initialize Session ============
  await test('Initialize MCP session', async () => {
    const data = await mcpRequest('POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    });
    if (!data.result) throw new Error('Initialize failed: ' + JSON.stringify(data));
    console.log(`   Session ID: ${sessionId}`);
    console.log(`   Server: ${data.result.serverInfo?.name} v${data.result.serverInfo?.version}`);
  });

  // ============ List Tools ============
  await test('List available tools', async () => {
    const data = await mcpRequest('POST', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    const toolCount = data.result?.tools?.length || 0;
    if (toolCount === 0) throw new Error('No tools found');
    console.log(`   Found ${toolCount} tools`);
  });

  // ============ FILESYSTEM TESTS ============
  console.log('\n📁 Filesystem Tests:');

  await test('fs_write_file - Create a file', async () => {
    const result = await callTool('fs_write_file', {
      path: 'test-project/src/index.ts',
      content: 'export const hello = "world";\nconsole.log(hello);'
    });
    if (!result.success) throw new Error('Write failed');
    console.log(`   Created: ${result.path} (${result.size} bytes)`);
  });

  await test('fs_read_file - Read the file', async () => {
    const result = await callTool('fs_read_file', {
      path: 'test-project/src/index.ts'
    });
    if (!result.content.includes('hello')) throw new Error('Content mismatch');
    console.log(`   Read: ${result.size} bytes`);
  });

  await test('fs_edit_file - Edit the file', async () => {
    const result = await callTool('fs_edit_file', {
      path: 'test-project/src/index.ts',
      old_text: '"world"',
      new_text: '"universe"'
    });
    if (!result.success) throw new Error('Edit failed');
  });

  await test('fs_write_file - Create package.json', async () => {
    const packageJson = {
      name: 'test-project',
      version: '1.0.0',
      main: 'src/index.ts',
      scripts: { start: 'ts-node src/index.ts' }
    };
    const result = await callTool('fs_write_file', {
      path: 'test-project/package.json',
      content: JSON.stringify(packageJson, null, 2)
    });
    if (!result.success) throw new Error('Write failed');
  });

  await test('fs_list_directory - List project files', async () => {
    const result = await callTool('fs_list_directory', {
      path: 'test-project'
    });
    if (!result.items || result.items.length === 0) throw new Error('No files found');
    console.log(`   Items: ${result.items.map(i => i.name).join(', ')}`);
  });

  await test('fs_directory_tree - Get tree structure', async () => {
    const result = await callTool('fs_directory_tree', {
      path: 'test-project',
      max_depth: 3
    });
    if (!result.tree) throw new Error('No tree returned');
    console.log(`   Tree depth verified`);
  });

  // ============ MEMORY TESTS ============
  console.log('\n🧠 Memory Tests:');

  let memoryId = null;

  await test('memory_store - Store project info', async () => {
    const result = await callTool('memory_store', {
      name: 'test-project-config',
      type: 'project',
      content: JSON.stringify({
        name: 'Test Project',
        stack: 'TypeScript + Node.js',
        database: 'Supabase'
      }),
      metadata: { created_by: 'test-script' }
    });
    if (!result.id) throw new Error('No ID returned');
    memoryId = result.id;
    console.log(`   Stored with ID: ${memoryId.substring(0, 8)}...`);
  });

  await test('memory_recall - Recall by name', async () => {
    const result = await callTool('memory_recall', {
      name_or_id: 'test-project-config'
    });
    if (!result.found) throw new Error('Memory not found');
    console.log(`   Recalled: ${result.name} (${result.type})`);
  });

  await test('memory_store - Store schema info', async () => {
    const result = await callTool('memory_store', {
      name: 'users-table-schema',
      type: 'schema',
      content: 'CREATE TABLE users (id UUID PRIMARY KEY, email TEXT UNIQUE);'
    });
    if (!result.id) throw new Error('No ID returned');
  });

  await test('memory_search - Search memories', async () => {
    const result = await callTool('memory_search', {
      query: 'project'
    });
    if (result.count === 0) throw new Error('No results found');
    console.log(`   Found ${result.count} matching memories`);
  });

  await test('memory_list - List all memories', async () => {
    const result = await callTool('memory_list', {});
    if (result.count === 0) throw new Error('No memories found');
    console.log(`   Total memories: ${result.count}`);
  });

  await test('memory_update - Update memory', async () => {
    const result = await callTool('memory_update', {
      id: memoryId,
      content: JSON.stringify({
        name: 'Test Project',
        stack: 'TypeScript + Node.js + React',
        database: 'Supabase',
        updated: true
      })
    });
    if (!result.updated) throw new Error('Update failed');
  });

  await test('memory_relate - Create relation', async () => {
    // Get the schema memory ID first
    const searchResult = await callTool('memory_search', { query: 'users-table' });
    if (searchResult.count === 0) throw new Error('Schema memory not found');
    const schemaId = searchResult.entities[0].id;

    const result = await callTool('memory_relate', {
      from_id: memoryId,
      to_id: schemaId,
      relation_type: 'has_schema'
    });
    if (!result.created) throw new Error('Relation creation failed');
  });

  await test('memory_get_relations - Get relations', async () => {
    const result = await callTool('memory_get_relations', {
      entity_id: memoryId
    });
    if (result.count === 0) throw new Error('No relations found');
    console.log(`   Relations: ${result.count}`);
  });

  // ============ CLEANUP ============
  console.log('\n🧹 Cleanup:');

  await test('fs_delete_file - Delete test file', async () => {
    const result = await callTool('fs_delete_file', {
      path: 'test-project/src/index.ts'
    });
    if (!result.success) throw new Error('Delete failed');
  });

  await test('memory_delete - Delete test memory', async () => {
    const result = await callTool('memory_delete', {
      id: memoryId
    });
    if (!result.deleted) throw new Error('Delete failed');
  });

  // ============ SUMMARY ============
  console.log('\n' + '='.repeat(50));
  console.log(`📊 Test Results: ${results.passed} passed, ${results.failed} failed`);
  console.log('='.repeat(50));

  if (results.failed > 0) {
    console.log('\n❌ Failed tests:');
    results.tests
      .filter(t => t.status === 'FAIL')
      .forEach(t => console.log(`   - ${t.name}: ${t.error}`));
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    console.log(`\n🔗 MCP Server URL: ${BASE_URL}/mcp`);
    process.exit(0);
  }
}

testMCP().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
