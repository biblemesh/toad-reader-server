const { handler } = require('../crons');

(async () => {

  await handler()
  process.exit()

})()