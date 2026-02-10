FROM node:20-alpine

WORKDIR /app

USER node

COPY --chown=node:node package.json ./
RUN npm install --production

COPY --chown=node:node *.js ./

CMD ["node", "index.js"]
