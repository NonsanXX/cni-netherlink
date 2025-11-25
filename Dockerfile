FROM node:lts
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping \
	&& rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm install
EXPOSE 4567
CMD ["npm", "run", "start"]