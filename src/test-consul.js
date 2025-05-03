// Simple test script to verify Consul connectivity
const axios = require('axios');
const os = require('os');

async function testConsul() {
  const consulUrl = 'http://localhost:8500';
  const hostname = os.hostname();
  const serviceId = `test-service-${hostname}-1234`;
  
  // Simple service registration payload
  const payload = {
    ID: serviceId,
    Name: 'test-service',
    Address: '127.0.0.1',
    Port: 1234,
    Check: {
      HTTP: 'http://127.0.0.1:1234/health',
      Interval: '15s'
    }
  };
  
  console.log('Testing Consul connection...');
  console.log(`Consul URL: ${consulUrl}`);
  console.log(`Payload: ${JSON.stringify(payload, null, 2)}`);
  
  try {
    // First check if Consul is available
    console.log('Checking Consul status...');
    const statusResponse = await axios.get(`${consulUrl}/v1/status/leader`);
    console.log(`Consul status: ${statusResponse.status} - Leader: ${statusResponse.data}`);
    
    // Then try to register a test service
    console.log('Attempting service registration...');
    const registerResponse = await axios.put(
      `${consulUrl}/v1/agent/service/register`, 
      payload
    );
    
    console.log(`Registration response status: ${registerResponse.status}`);
    console.log('Service registered successfully!');
    
    // Clean up by deregistering the service
    console.log('Cleaning up test service...');
    const deregisterResponse = await axios.put(
      `${consulUrl}/v1/agent/service/deregister/${serviceId}`
    );
    console.log(`Deregistration response status: ${deregisterResponse.status}`);
    console.log('Service deregistered successfully!');
    
  } catch (error) {
    console.error('Error connecting to Consul:');
    console.error(`Message: ${error.message}`);
    
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error('No response received - Consul may not be running');
    }
  }
}

testConsul(); 