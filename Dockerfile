# mediasoup ships a native worker. The npm install downloads a prebuilt binary
# and falls back to compiling it, which needs a toolchain and Python, so install
# in the full image and run from the slim one (same glibc, so the binary carries over).
FROM node:lts-bookworm AS deps

WORKDIR /app

COPY package*.json ./

# Install dependencies from the lockfile (reproducible, prod only)
RUN npm ci --omit=dev

FROM node:lts-bookworm-slim

# Set working directory
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# Copy the rest of the application code
COPY --chown=node:node . .

# Drop root privileges
USER node

# Expose the port the app runs on
EXPOSE 824

# Start the application
CMD ["npm", "start"]
