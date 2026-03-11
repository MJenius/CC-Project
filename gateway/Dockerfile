FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

# Instead of copying index.js here, we rely on the bind mount
# for development hot reloading.
# We map the volume in docker-compose, and use nodemon to
# start the app. 
CMD ["npx", "nodemon", "index.js"]
