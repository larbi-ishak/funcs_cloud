/**
 * A sample Node.js handler for the Nova platform.
 * The handler receives an `event` object containing the HTTP request details.
 */
exports.handler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2));

    // Extract query parameters, headers, and body
    const name = event.query.name || "World";
    const bodyData = event.json || {};

    // Simulate some processing delay
    await new Promise(resolve => setTimeout(resolve, 50));

    // Return an HTTP response
    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "X-Powered-By": "Nova-NodeJS"
        },
        body: {
            message: `Hello, ${name}! Welcome to Nova Node.js Runtime.`,
            request_method: event.method,
            request_path: event.path,
            received_body: bodyData,
            timestamp: new Date().toISOString()
        }
    };
};
