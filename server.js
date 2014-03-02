var formidable = require('formidable'),
    http = require('http'),
    fs = require('fs'),
    url = require("url"),
    util = require('util'),
    //request = require('request'),
    btcAddr = require('bitcoin-address'),
    path = require('path'),
    mime = require('mime'),
    MongoClient = require('mongodb').MongoClient,
    format = require('util').format,
    cronJob = require('cron').CronJob,
    mongo = require('mongodb'),
    BSON = mongo.BSONPure,
    bitcoin = require('bitcoin'),
    config = require('./config');

var logger = require('tracer').console();

var minutesPerBTCPerMB = 262800, //6 months in minutes
    minutesBurnedPerDownload = 10, //1 download = 10 minutes of storage. Size is accounted for already.
    margin = 1.5, //margin charged
    profitWallet = '15N5XaCEpw3SBM1CqJamhvF3zhbfv2vLjG',
    profitAccountName = 'profits',
    baseTxFee = 0.0001;
    collection = null;

//connect to bitcoin daemon
var client = new bitcoin.Client({
  host: 'localhost',
  port: 8332,
  user: config.user_name,
  pass: config.password
}); 

settxfee(baseTxFee);


logger.log('Connecting to mongo');
MongoClient.connect('mongodb://127.0.0.1:27017/test', function(err, db) { 


  if(err) throw err; 
  collection = db.collection('uploadedFiles');

  logger.log('Connection to mongo complete');

  //collection.ensureIndex({expiryTime: 1});
  //TODO set indexes

  //every minute delete files that have expired.
  new cronJob('* * * * *', function(){
    deleteExpiredFiles(collection);
  }, null, true);    

  //every 10 seconds check if payment is received
  var paymentCron = new cronJob('*/10 * * * * *', function(){
    checkPayments(collection);
  }, null, true);





  //create http server
  http.createServer(function(req, res) {

    logger.log('Hit');

    if (req.url == '/upload' && req.method.toLowerCase() == 'post') {
      // parse a file upload
      var form = new formidable.IncomingForm();
      form.keepExtensions = true;


      form.parse(req, function(err, fields, file) {
        
        var id = null;

        //store name of file and details in mongodb
        file.title = fields.title;
        file.referralBTCAddress = fields.referralBTCAddress;
        file.referralBTCPrice = fields.referralBTCPrice;
	
      	//store uploaded time
      	file.uploadedDate = new Date().getTime();
              
      	//store expiry time 30 minutes in the future
        file.expiryTime = new Date().getTime() + (30*60*1000);

        //set account name to current time - TODO update this to something more sensible
        file.bitcoinAccount = '' + new Date().getTime();//

        //generate new bitcoin address for payments
        client.cmd('getnewaddress', file.bitcoinAccount,function(err,address){
          if (err) return logger.log(err);

          file.bitcoinAddress = address;
          file.btcBalance = 0.00000000;

          file.btcDownloadCost = Math.max(file.referralBTCPrice * margin, (file.upload.size / 1000000 / minutesPerBTCPerMB * minutesBurnedPerDownload * margin) + parseFloat(file.referralBTCPrice));//max of referral * margin or (our base costs + referral price) * margin - accounts for very low referral cost uploads.

          collection.insert(file, function(err, docs) {

            id = docs[0]._id;

            collection.count(function(err, count) {
              logger.log(format("Uploaded file count since last reset = %s", count));
            });

            //return only public items
            var thisItem = {};
            thisItem.size = file.upload.size;
            thisItem.name = file.upload.name;
            thisItem.type = file.upload.type;
            thisItem.title = file.title;
            thisItem.uploadedDate = file.uploadedDate;
            thisItem.expiryTime = file.expiryTime;
            thisItem.bitcoinAddress = file.bitcoinAddress;
            thisItem.btcBalance = file.btcBalance;
            thisItem.serverTime = new Date().getTime();
            thisItem.downloadURL = '/download/' + id;
            thisItem.statusURL = '/status/' + id;

            //send response to user
            res.writeHead(200, {'content-type': 'application/json'});
            res.write(JSON.stringify(thisItem));

            return res.end();
            
          });
        });
      });

      return;
    }


    var downloadURL = '/download/';
    if (strStartsWith(req.url,downloadURL)){

      var fileID = req.url.substring(downloadURL.length);
      
      //if requesting supossedly paid download
      if (fileID.indexOf('/?payment=') != -1){

        fileID = fileID.substring(0, req.url.indexOf('/?payment=') - 10);

        var addressacc = req.url.substring(req.url.indexOf('/?payment=') + 10);
        var address = addressacc.substring(0, addressacc.indexOf('&account='));
        var bitcoindAccount = addressacc.substring(addressacc.indexOf('&account=') + 9);

        //check payment is received
        client.getBalance(bitcoindAccount, 0, function(err, balance) {
          if (!err) {

            collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {
              if (item != null){
                if (balance >= item.btcDownloadCost){

                  if (addressInItemDownloadAddresses(address,item)){ //address could be any address - check it's in the array

                    //allow download (once) 
                    logger.log('Downloading paid file : ' + item.upload.path);

                    var file = item.upload.path;
                    var filename = path.basename(file);
                    var mimetype = mime.lookup(file);

                    res.setHeader('Content-disposition', 'attachment; filename=' + filename);
                    res.setHeader('Content-type', mimetype);

                    var filestream = fs.createReadStream(file);
                    filestream.pipe(res);

                    //delete download url
                    collection.update({ '_id': new BSON.ObjectID(fileID) },{ $pull: { downloadAddress: {address: address, paid: false, account: bitcoindAccount} } }, function(err, doc){
                      if (err) return logger.error(err);
                      if(doc != 1) return logger.error('Error - ' + doc);

                      logger.log('Deleted download address after single paid download.');
                    });

                    //make bitcoin payments: referralBTCPrice to the referralBTCAddress, 50% of what is left to the downloaded file's fee address, and the rest to the owner.
                    //to deal with transaction fees this will have to pay out only once there is a high enough balance. TODO limit min transactions / batch them
                    //payments can be queued and batched once a certain threshold is reached.

                    var txfees = 1 * baseTxFee;
                    var referralFee = item.referralBTCPrice - txfees; //has to pay fee
                    var uploadExtentionFee = (balance - referralFee) / 2; //no need to pay fee
                    var profitFee = (balance - referralFee) / 2; //no need to pay fee
                    

                    //send fee to uploader
                    client.cmd('sendfrom', bitcoindAccount, item.referralBTCAddress, referralFee, 0, function(err, result){
                      if (err) {
                        logger.error(err);
                      }else{
                        logger.log(referralFee + 'BTC referral paid to uploader. '+result);
                      }
                    });

                    //move 50% of remainder to uploaded item's expiry extension account
                    client.cmd('move', bitcoindAccount, item.bitcoinAccount, uploadExtentionFee, 0, function(err, result){
                      if (err) {
                        logger.error(err);
                      }else{
                        logger.log(uploadExtentionFee + 'BTC Payment made to extend expiry time. '+result);
                      }
                    });

                    //move rest to profit account
                    client.cmd('move', bitcoindAccount, item.bitcoinAccount, profitFee, 0, function(err, result){
                      if (err) {
                        logger.error(err);
                      }else{
                        logger.log(profitFee + 'BTC Profits moved to dividend account. '+result);
                      }
                    });
                    

                  }else{
                    res.writeHead(200, {'content-type': 'text/plain'});
                    res.write('Address not linked to file.');
                    return res.end();
                  }

                }else{
                  res.writeHead(200, {'content-type': 'text/plain'});
                  res.write('No payment received or payment too small.');
                  return res.end();
                }
              }else{
                res.writeHead(200, {'content-type': 'text/plain'});
                res.write('Error. Item has expired.');
                return res.end();
              }
            });
          }else{
            logger.error(err);
            res.writeHead(200, {'content-type': 'text/plain'});
            res.write('Error. Cannot connect to blockexplorer.com');
            return res.end();
          }
        });

        return;
      }

      //get path from mongo (if file exists)
      if (fileID.length == 24){
        collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {

          if (item != null){


            //two file types: 1 - prepaid by uploader, anyone who downloads pays and proceeds are split between admin, program (expiry extension), and uploader
            if (btcAddr.validate(item.referralBTCAddress) || btcAddr.validate(item.referralBTCAddress,'testnet')){ //if referral address exists. (prod or testnet)

              //Create new btcaddress for downloader with 15 minutes to pay
              //After payment the user can download using currentURL?payment=NewBitcoinAddress
              //attach address to account:
              var bitcoindAccount = fileID+(new Date().getTime());
              client.cmd('getnewaddress', bitcoindAccount, function(err,address){
                if (err) return logger.error(err);

                collection.update({ '_id': new BSON.ObjectID(fileID) },{ $push: { downloadAddress: {address: address, paid: false, account: bitcoindAccount} } }, function(err, doc){
                  if (err) return logger.error(err);

                  if(doc != 1){
                    logger.error('Error - ' + doc);
                    return;
                  }

                  logger.log("Added payment address " + address + "to uploaded file.");

                  var responseItem = {
                    amountToPay: item.btcDownloadCost,
                    timeToPay: '15 minutes',
                    paymentAddress: address,
                    downloadLink: '/download/' + fileID + '/?payment=' + address + '&account=' + bitcoindAccount
                  };

                  //delete download address after 15 minutes if btc payment is not complete.
                  var myTimeout = setTimeout(function() {
                    collection.update({ '_id': new BSON.ObjectID(fileID) },{ $pull: { downloadAddress: {address: address, paid: false, account: bitcoindAccount} } }, function(err, doc){
                      if (err) return logger.error(err);
                      if(doc != 1) return logger.error('Error - ' + doc);
                      logger.log('Added new address for download payment');
                    });
                  }, 15 * 60 * 1000); //15 minutes

                  var x=0;
                  var myInterval = setInterval(function() {

                    //if payment not made delete the download address
                    client.getBalance(bitcoindAccount, 0, function(err, balance) {
                      if (!err) { 

                        if (balance < item.btcDownloadCost){  //not paid
                          //if 15 minutes past then address will be deleted by timeout above.
                          
                          //if 15 minutes past then stop this interval
                          if(x >= 90){
                            clearInterval(myInterval); //stop this interval being called again.
                          }
                          
                          x++;

                        }
                      }else{
                        logger.error(err);
                        res.writeHead(200, {'content-type': 'text/plain'});
                        res.write('Error. Cannot connect to bitcoind');
                        return res.end();
                      }
                    });

                  }, 10 * 1000); //10 seconds

                  res.writeHead(200, {'content-type': 'application/json'});
                  res.write(JSON.stringify(responseItem));
                  return res.end();

                });
              });


            }else{ //two file types: 2 - prepaid by uploader, and expiry time decreases as time goes on.


              //Don't let file be downloaded if nothing has been paid.
              //logger.debug('Account = ' + item.bitcoinAccount);

              client.getBalance(item.bitcoinAccount, 0, function(err, balance) {
                if (!err) {

                  if (balance == 0){
                    res.writeHead(200, {'content-type': 'text/plain'});
                    res.write('Please make payment first.');
                    return res.end();
                  }

                  //Reduce expiry time by bandwidth charge/cost
                  minutesBurned = -1 * minutesBurnedPerDownload * 60 * 1000; //minutes to milliseconds
                  collection.update({ '_id': new BSON.ObjectID(fileID) },{ $inc: { expiryTime: (minutesBurned) } }, function(err, doc){
                    if (err) return logger.error(err);

                    if(doc != 1){
                      logger.error('Error - ' + doc);
                      return;
                    }   

                    //download file
                    logger.log('Downloading : ' + item.upload.path);

                    var file = item.upload.path;
                    var filename = path.basename(file);
                    var mimetype = mime.lookup(file);

                    res.setHeader('Content-disposition', 'attachment; filename=' + filename);
                    res.setHeader('Content-type', mimetype);

                    var filestream = fs.createReadStream(file);
                    filestream.pipe(res);

                  }); 
                }else{
                  logger.error(err);
                  res.writeHead(200, {'content-type': 'text/plain'});
                  res.write('Error.' + JSON.stringify(err));
                  return res.end();
                }
              });
            }

          }else{
            res.writeHead(200, {'content-type': 'text/plain'});
            res.write('File not found.');
            return res.end();
          }

        });
      }else{
          res.writeHead(200, {'content-type': 'text/plain'});
          res.write('File not found.');
          return res.end();
      }
      return;
    }

    var statusURL = '/status/';
    if (strStartsWith(req.url,statusURL)){

      //get path from mongo (if file exists)
      var fileID = req.url.substring(statusURL.length);
      if (fileID.length == 24){
        collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {

            if (item != null){

              //return only public items
              var thisItem = {};
              thisItem.size = item.upload.size;
              thisItem.name = item.upload.name;
              thisItem.type = item.upload.type;
              thisItem.title = item.title;
              thisItem.uploadedDate = item.uploadedDate;
              thisItem.expiryTime = item.expiryTime;
              thisItem.bitcoinAddress = item.bitcoinAddress;
              thisItem.btcBalance = item.btcBalance;
              thisItem.serverTime = new Date().getTime();
              thisItem.downloadURL = '/download/' + item._id;
              thisItem.statusURL = '/status/' + item._id;

              //send response
              res.writeHead(200, {'content-type': 'application/json'});
              res.write(JSON.stringify(thisItem));
              return res.end();

            }else{
              res.writeHead(200, {'content-type': 'text/plain'});
              res.write('File not found.');
              return res.end();
            }

        });
      }else{
          res.writeHead(200, {'content-type': 'text/plain'});
          res.write('File not found.');
          res.end();
      }
      return;
    }

    // show a file upload form
    res.writeHead(200, {'content-type': 'text/html'});
    res.end(
      '<form action="/upload" enctype="multipart/form-data" method="post">'+
      '<p>This project is in alpha testing. Do not assume anything will work, it might swallow your money.</p>'+
      '<p>There are 2 ways of using this system:'+
      '<br/>1 : Upload a file, and pay for it to remain online. Every paid satoshi the file stays online for more time, every download the timer is cut short a bit to cover bandwidth costs.'+
      '<br/>2 : Upload a file with a refferal bitcoin address and a price. Every time someone downloads it they will pay that price + 50%. The price you set (-tx fees) is paid to the referral btc address each time someone pays to download, and the 50% goes towards hosting that file for longer.</p>'+
      'If nothing is paid after 30 minutes the uploaded file will expire and be deleted. No one can download the file until at least 1 satoshi has been paid.<br/><br/>'+
      '<input type="text" name="title">Enter a title (optional)<br>'+
      '<input type="text" name="referralBTCAddress">Enter a refferal address (optional)<br>'+
      '<input type="text" name="referralBTCPrice">Enter a refferal price (optional)<br>'+
      '<input type="file" name="upload"><br>'+
      '<input type="submit" value="Upload">'+
      '</form>'
    );
  }).listen(80);
})


//return true if str starts with prefix
function strStartsWith(str, prefix) {
    return str.indexOf(prefix) === 0;
}


//if address is in download addresses of item return true
function addressInItemDownloadAddresses(address, item){

  if (item.downloadAddress == null ){
    return false;
  }

  var downloadAddressArr = item.downloadAddress;
  for (var i = 0; i < downloadAddressArr.length; i++){
    if (downloadAddressArr[i].address == address){
      return true;
    }
  }

  return false;
}

//set tx fee for bitcoin transactions
function settxfee(btc){
  client.cmd('settxfee', btc,function(err,result){
    if (err){
      logger.error('Error setting TX fee');
      logger.error(err);
    }else{
      logger.log('TX fee set to ' + baseTxFee);
    }
  });
}

function deleteExpiredFiles(collection){
  collection.find({expiryTime: {$lt: new Date().getTime()}}).toArray(function(err, items) {

      collection.remove({expiryTime: {$lt: new Date().getTime()}}, function(err) {
        if(items.length > 0){
          logger.log(items.length + ' expired files deleted.');
        }
      });

      //remove the actual files from disk
      items.forEach(function(thisItem) {

        
        //send btc profits for that account to owner
        //get balance
        client.getBalance(thisItem.bitcoinAccount, 0, function(err, balance) {
          if (err) {
            logger.error(err);
          }else if (balance == 0){
            logger.log('No bitcoins paid for this expired file.');
          }else{
            //move balance
            client.cmd('move', thisItem.bitcoinAccount, profitAccountName, balance, 0, function(err, result){
              if (err) {
                logger.error(err);
              }else{
                logger.log('Profits moved to dividend account. '+result);
              }
            });
          }
        });

        fs.unlink(thisItem.upload.path, function (err) {
          if (err) throw err;
          logger.log('successfully deleted file.');
        });
      });

    });
}

function checkPayments(collection){
  collection.find().toArray(function(err, items) {
    if (err) return logger.error(err);
    
    //for (var i=0; i<items.length; i++){
    items.forEach(function(thisItem) {

      var thisID = thisItem._id.toString();
      var oldBalance = parseFloat(thisItem.btcBalance);
      var filesize = thisItem.upload.size/1000000; //size in MB
      var thisbitcoinAddress = thisItem.bitcoinAddress;
      var thisbitcoinAccount = thisItem.bitcoinAccount;

      //if bitcoin payment is received then extend expiry time by 1 minute / satoshi     
      client.getBalance(thisbitcoinAccount, 0, function(err, balance) {
        if (!err) {

          //logger.debug('Balance for ' + thisbitcoinAddress + ' = ' + balance);

          if (oldBalance != balance){

            //update balance in DB
            collection.update({ '_id': new BSON.ObjectID(thisID) },{ $set: { btcBalance: (balance) } }, function(err, doc){
              if (err) return logger.error(err);
              logger.log('BTC balance updated for account ID ' + thisbitcoinAccount + ' - new balance: ' + balance)
            });

            //extend expiry time by correct amount.
            var btcDiff = balance - oldBalance;
            var minutesToExtend = btcDiff*minutesPerBTCPerMB/filesize;
            collection.update({ '_id': new BSON.ObjectID(thisID) },{ $inc: { expiryTime: (minutesToExtend*60*1000) } }, function(err, doc){
              if (err) return logger.error(err);
              logger.log('Extended expiry time by ' + minutesToExtend + ' minutes.');
            });

          }
        }else{
          logger.error('Cannot connect to blockchain.info');
        }

      }); 
    });
  });
}



