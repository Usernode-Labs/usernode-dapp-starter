FROM node:20-alpine

RUN mkdir -p /app && chown node:node /app
WORKDIR /app

USER node

COPY --chown=node:node package.json ./
RUN npm install --production

COPY --chown=node:node *.js ./

CMD ["node", "index.js"]
