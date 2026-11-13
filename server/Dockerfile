# node:sqlite needs the flag on Node 22 (unflagged from Node 24).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.js dashboard.html ./
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--experimental-sqlite", "server.js"]
