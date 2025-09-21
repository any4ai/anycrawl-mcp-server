import https from 'https';

const debugRemoteServer = () => {
    return new Promise((resolve, reject) => {
        console.log('🔍 Debugging remote server: https://mcp.anycrawl.dev/abc/sse');
        
        const options = {
            hostname: 'mcp.anycrawl.dev',
            port: 443,
            path: '/abc/sse',
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        };
        
        const req = https.request(options, (res) => {
            console.log('📡 Response status:', res.statusCode);
            console.log('📡 Response headers:', JSON.stringify(res.headers, null, 2));
            
            let data = '';
            let chunkCount = 0;
            
            res.on('data', (chunk) => {
                chunkCount++;
                data += chunk.toString();
                console.log(`📦 Chunk ${chunkCount}:`, JSON.stringify(chunk.toString()));
            });
            
            res.on('end', () => {
                console.log('✅ Connection ended normally');
                console.log('📊 Total chunks received:', chunkCount);
                console.log('📄 Total data length:', data.length);
                resolve({ statusCode: res.statusCode, chunkCount, data });
            });
            
            res.on('error', (err) => {
                console.error('❌ Response error:', err);
                reject(err);
            });
        });
        
        req.on('error', (err) => {
            console.error('❌ Request error:', err);
            reject(err);
        });
        
        req.on('timeout', () => {
            console.log('⏰ Request timeout');
            req.destroy();
            resolve({ statusCode: 'timeout', chunkCount: 0, data: 'timeout' });
        });
        
        req.setTimeout(10000); // 10 second timeout
        req.end();
    });
};

// Test different endpoints
const testEndpoints = async () => {
    const endpoints = [
        '/health',
        '/abc/mcp',
        '/abc/sse'
    ];
    
    for (const endpoint of endpoints) {
        console.log(`\n🧪 Testing endpoint: ${endpoint}`);
        
        try {
            const response = await fetch(`https://mcp.anycrawl.dev${endpoint}`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json, text/event-stream, */*'
                }
            });
            
            console.log(`✅ Status: ${response.status}`);
            console.log(`📋 Headers:`, Object.fromEntries(response.headers.entries()));
            
            if (endpoint === '/health') {
                const text = await response.text();
                console.log(`📄 Body: ${text}`);
            }
        } catch (error) {
            console.error(`❌ Error:`, error.message);
        }
    }
};

// Run tests
const runDebug = async () => {
    console.log('🚀 Starting remote server debug...\n');
    
    try {
        await testEndpoints();
        
        console.log('\n🔍 Testing SSE endpoint specifically...');
        await debugRemoteServer();
        
    } catch (error) {
        console.error('\n💥 Debug failed:', error);
    }
};

runDebug();
