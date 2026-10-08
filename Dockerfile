FROM node:22-alpine
WORKDIR /app
COPY server.js VERSION ./
COPY lib ./lib
COPY public ./public
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
