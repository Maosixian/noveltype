FROM node:24.17.0-bookworm-slim
WORKDIR /opt/noveltype
COPY server ./server
COPY app/translation.cjs app/alignment.cjs app/demo-alignment.cjs ./app/
ENV NODE_ENV=production NOVELTYPE_HOST=0.0.0.0 NOVELTYPE_PORT=3000 NOVELTYPE_DATA_DIR=/data
USER node
EXPOSE 3000
CMD ["node", "server/index.cjs"]
