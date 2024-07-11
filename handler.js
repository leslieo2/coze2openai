import awsServerlessExpress from 'aws-serverless-express';
import app from './app.js'; // Make sure to include the .js extension
const server = awsServerlessExpress.createServer(app);

export const handler = (event, context) => {
    awsServerlessExpress.proxy(server, event, context);
};