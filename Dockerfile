# Repli si Coolify/Nixpacks ne detecte pas Node automatiquement.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=2567
EXPOSE 2567
CMD ["npm", "start"]
