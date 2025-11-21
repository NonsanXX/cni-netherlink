FROM node:lts
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 4567
CMD ["npm", "run", "start"]