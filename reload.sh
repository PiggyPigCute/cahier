git pull
npm install --omit=dev
pm2 reload cahier || PORT=3007 pm2 start server.js --name cahier
