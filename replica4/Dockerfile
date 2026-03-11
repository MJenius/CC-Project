FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

CMD ["npx", "nodemon", "index.js"]
