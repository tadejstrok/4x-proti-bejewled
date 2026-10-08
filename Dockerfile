FROM node:24-alpine

# sqlite CLI is only for moderation/backups via `kubectl exec`.
RUN apk add --no-cache sqlite \
  && mkdir /data && chown node:node /data

WORKDIR /app
COPY index.html style.css ./
COPY js ./js
COPY public ./public
COPY server/server.js server/admin.html ./server/

ENV PORT=8080 DB_PATH=/data/scores.db NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
