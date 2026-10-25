FROM node:24-alpine
WORKDIR /app
COPY server.js VERSION ./
COPY lib ./lib
COPY http ./http
COPY web ./web
COPY routes ./routes
COPY public ./public
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
