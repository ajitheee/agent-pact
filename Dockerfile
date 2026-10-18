# Manufact's default build (node:22-alpine, npm install, mcp-use build, npm start) plus Python 3,
# which the sandboxed Python verifier needs. Deploy with: npx mcp-use deploy --dockerfile Dockerfile
FROM node:22-alpine
RUN apk add --no-cache python3
WORKDIR /app
COPY . ./
RUN npm install && npm run build
ENV HOST=0.0.0.0 PORT=3000 PYTHON_BIN=python3
EXPOSE 3000
CMD ["npm", "start"]
