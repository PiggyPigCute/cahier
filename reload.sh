git pull
npm install --omit=dev
pm2 reload poly || PORT=3008 pm2 start server.js --name poly
