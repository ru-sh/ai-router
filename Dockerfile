# ---- Builder Stage ----
    FROM node:23-alpine AS builder
    WORKDIR /app
    
    # Install yarn (optional, but good practice if not guaranteed in base image)
    # For alpine, you can do:
    RUN apk add --no-cache yarn
    
    COPY package.json yarn.lock ./
    RUN yarn install --frozen-lockfile
    
    COPY . .
    RUN yarn run build
    
    # ---- Runtime Stage ----
    FROM node:23-alpine
    WORKDIR /app
    ENV NODE_ENV=production
    
    # Install yarn again if needed for runtime commands, or ensure base image has it
    # RUN apk add --no-cache yarn # Uncomment if yarn needed at runtime and not in base image
    
    COPY package.json yarn.lock ./
    RUN yarn install --production --frozen-lockfile && yarn cache clean --force
    
    COPY --from=builder /app/dist ./dist
    EXPOSE 8034
    USER node
    CMD [ "yarn", "run", "serve" ]