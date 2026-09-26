FROM node:22-slim
WORKDIR /app
COPY --chown=node:node --chmod=644 package.json server.js ledger.js decide.js notes.js world.json ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
