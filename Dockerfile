# AudioShelf Librarian - Node.js Monorepo
FROM node:20-slim

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3050

# Set working directory
WORKDIR /app

# Copy root package files
COPY package*.json ./
COPY tsconfig.base.json ./

# Install build tools for native dependencies (like better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy workspaces
COPY packages/ ./packages/
COPY apps/ ./apps/

# Install dependencies (ignoring dev dependencies where possible, 
# but we need to build the typescript files)
RUN npm install

# Build all workspaces
RUN npm run build --workspaces --if-present

# Create necessary directories
RUN mkdir -p /app/data /app/logs

# Expose backend port
EXPOSE 3050

# Start the backend server
CMD ["npm", "start", "--workspace", "apps/backend"]
