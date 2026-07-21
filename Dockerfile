# Use official Node.js LTS image
FROM node:lts-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies from the lockfile (reproducible, prod only)
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY --chown=node:node . .

# Drop root privileges
USER node

# Expose the port the app runs on
EXPOSE 824

# Start the application
CMD ["npm", "start"]
