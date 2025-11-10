# 1. Usar una imagen base de Node.js
FROM node:18-alpine

# 2. Establecer el directorio de trabajo dentro del contenedor
WORKDIR /app

# 3. Copiar los archivos de dependencias
COPY package*.json ./

# 4. Instalar las dependencias
RUN npm install

# 5. Copiar todo el código de tu proyecto al contenedor
COPY . .

# 6. Exponer el puerto que usa tu app (¡ajusta este número!)
EXPOSE 8080

# 7. El comando para iniciar tu app (¡ajusta este comando!)
CMD ["npm", "start"]