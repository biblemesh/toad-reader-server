const AWS = require('aws-sdk')

// SES setup
const sesConfig = {
  region: process.env.SES_AWS_REGION || 'us-east-1',
}
if(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY) {
  sesConfig.accessKeyId = process.env.SES_ACCESS_KEY_ID
  sesConfig.secretAccessKey = process.env.SES_SECRET_ACCESS_KEY
}
const SES = new AWS.SES(sesConfig)


const executeSendEmail = ({ queuedEmail, resolve, reject }) => {

  const { toAddrs, ccAddrs, bccAddrs, fromAddr, replyToAddrs, subject, body } = queuedEmail

  SES.sendEmail({
    Destination: {
      ToAddresses: toAddrs,
      CcAddresses: ccAddrs,
      BccAddresses: bccAddrs,
    },
    Message: {
      Body: {
        Html: {
          Charset: "UTF-8", 
          Data: body,
        }, 
      }, 
      Subject: {
        Charset: "UTF-8", 
        Data: subject,
      }
    }, 
    Source: fromAddr, 
    ReplyToAddresses: replyToAddrs,
  }, async (err, data) => {

    try {

      if(err) {
        console.log('Email error: ', err, JSON.stringify(queuedEmail))
        reject(error.message || 'email send failed')
      }

      resolve && resolve(true)

    } catch(err) {
      reject(error.message || 'email send failed')
    }

  })
}

module.exports = executeSendEmail
