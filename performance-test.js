const autocannon = require('autocannon');
const { Pool } = require('pg');

// Performance testing configuration
const config = {
  url: 'http://localhost:3000',
  connections: 10,
  duration: 10,
  pipelining: 1,
  timeout: 10
};

// Database performance test
async function testDatabasePerformance() {
  console.log('🔍 Testing database performance...');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    // Test connection pool
    const startTime = Date.now();
    const client = await pool.connect();
    const connectionTime = Date.now() - startTime;
    console.log(`✅ Database connection time: ${connectionTime}ms`);
    
    // Test query performance
    const queryStart = Date.now();
    const result = await client.query('SELECT COUNT(*) FROM atendimentos');
    const queryTime = Date.now() - queryStart;
    console.log(`✅ Query execution time: ${queryTime}ms`);
    console.log(`✅ Total records: ${result.rows[0].count}`);
    
    client.release();
    
    // Test pool statistics
    console.log(`📊 Pool total connections: ${pool.totalCount}`);
    console.log(`📊 Pool idle connections: ${pool.idleCount}`);
    
  } catch (error) {
    console.error('❌ Database test failed:', error.message);
  } finally {
    await pool.end();
  }
}

// API endpoint performance test
async function testAPIEndpoints() {
  console.log('\n🚀 Testing API endpoints performance...');
  
  const endpoints = [
    '/wake-up',
    '/atendimentos',
    '/estatisticas'
  ];
  
  for (const endpoint of endpoints) {
    console.log(`\n📡 Testing ${endpoint}...`);
    
    try {
      const result = await autocannon({
        ...config,
        url: `${config.url}${endpoint}`,
        headers: {
          'Authorization': 'Bearer test-token'
        }
      });
      
      console.log(`✅ ${endpoint}:`);
      console.log(`   Average latency: ${result.latency.average}ms`);
      console.log(`   Requests/sec: ${result.requests.average}`);
      console.log(`   Total requests: ${result.requests.total}`);
      console.log(`   Errors: ${result.errors}`);
      
    } catch (error) {
      console.error(`❌ ${endpoint} test failed:`, error.message);
    }
  }
}

// Load testing with authentication
async function testAuthenticatedEndpoints() {
  console.log('\n🔐 Testing authenticated endpoints...');
  
  try {
    // First get a token
    const loginResult = await autocannon({
      ...config,
      url: `${config.url}/login`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'admin',
        password: 'senha123'
      })
    });
    
    console.log('✅ Login endpoint performance:');
    console.log(`   Average latency: ${loginResult.latency.average}ms`);
    console.log(`   Requests/sec: ${loginResult.requests.average}`);
    
    // Test with token (simulated)
    const authResult = await autocannon({
      ...config,
      url: `${config.url}/atendimentos`,
      headers: {
        'Authorization': 'Bearer simulated-token'
      }
    });
    
    console.log('✅ Authenticated endpoint performance:');
    console.log(`   Average latency: ${authResult.latency.average}ms`);
    console.log(`   Requests/sec: ${authResult.requests.average}`);
    
  } catch (error) {
    console.error('❌ Authenticated test failed:', error.message);
  }
}

// Memory and CPU usage monitoring
function monitorResources() {
  console.log('\n💾 Resource usage:');
  const usage = process.memoryUsage();
  console.log(`   RSS: ${Math.round(usage.rss / 1024 / 1024)} MB`);
  console.log(`   Heap Total: ${Math.round(usage.heapTotal / 1024 / 1024)} MB`);
  console.log(`   Heap Used: ${Math.round(usage.heapUsed / 1024 / 1024)} MB`);
  console.log(`   External: ${Math.round(usage.external / 1024 / 1024)} MB`);
}

// Main performance test runner
async function runPerformanceTests() {
  console.log('🚀 Starting performance tests...\n');
  
  const startTime = Date.now();
  
  try {
    await testDatabasePerformance();
    await testAPIEndpoints();
    await testAuthenticatedEndpoints();
    monitorResources();
    
    const totalTime = Date.now() - startTime;
    console.log(`\n✅ All performance tests completed in ${totalTime}ms`);
    
  } catch (error) {
    console.error('\n❌ Performance tests failed:', error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runPerformanceTests();
}

module.exports = {
  testDatabasePerformance,
  testAPIEndpoints,
  testAuthenticatedEndpoints,
  monitorResources,
  runPerformanceTests
};