 var formidable = require('formidable'),
    http = require('http'),
    fs = require('fs'),
    url = require("url"),
    util = require('util');

var path = require('path');
var mime = require('mime');

var collection = null;
var MongoClient = require('mongodb').MongoClient
    , format = require('util').format;
var cronJob = require('cron').CronJob;

var mongo = require('mongodb');
var BSON = mongo.BSONPure;
var bitcoin = require('bitcoin');

var minutesPerBTCPerMB = 1051200; //2 years in minutes
var minutesBurnedPerDownload = 10; //1 download = 10 minutes of storage. Size is accounted for already.
var margin = 1.5; //margin charged

//connect to bitcoin daemon
var client = new bitcoin.Client({
  host: 'localhost',
  port: 8332,
  user: 'hughht5',
  pass: '6Yr8ZRmK53m59bCZHt3ybeMFpUi5KQfC5uC7qnHQqnbk'
}); 


MongoClient.connect('mongodb://127.0.0.1:27017/test', function(err, db) { 

  if(err) throw err; 
  collection = db.collection('uploadedFiles3');

  //collection.ensureIndex({expiryTime: 1});

  //every minute delete files that have expired.
  new cronJob('* * * * *', function(){

    collection.find({expiryTime: {$lt: new Date().getTime()}}).toArray(function(err, items) {
      collection.remove({expiryTime: {$lt: new Date().getTime()}}, function(err) {
        console.log(items.length + ' expired files deleted.');
       
      });

      //remove the actual files from disk
      for (var i=0; i<items.length; i++){
        fs.unlink(items[i].upload.path, function (err) {
          if (err) throw err;
          console.log('successfully deleted file.');
        });
      }

    });
  }, null, true);    

  //every 10 seconds check if payment is received


  var paymentCron = new cronJob('*/10 * * * * *', function(){

    collection.find().toArray(function(err, items) {

      for (var i=0; i<items.length; i++){

        var oldBalance = items[i].btcBalance;
        var thisID = items[i]._id;
        var filesize = items[i].upload.size/1000000; //size in MB

        //if bitcoin payment is received then extend expiry time by 1 minute / satoshi     
        client.getBalance(items[i].bitcoinAddress, 0, function(err, balance) {
          if (err) return console.log(err);

          if (oldBalance != balance){

            //update balance in DB
            collection.update({ '_id': new BSON.ObjectID(thisID) },{ $set: { btcBalance: (balance) } }, function(err, doc){
              if (err) return console.log(err);
              console.log('BTC balance updated - new balance: ' + balance);
            });

            //extend expiry time by correct amount.
            var btcDiff = balance - oldBalance;
            var minutesToExtend = btcDiff*minutesPerBTCPerMB/filesize;
            collection.update({ '_id': new BSON.ObjectID(thisID) },{ $inc: { expiryTime: (minutesToExtend*60*1000) } }, function(err, doc){
              if (err) return console.log(err);
              console.log('extended expiry time by ' + minutesToExtend);
            });

          }

        }); 
      }
    });
  }, null, true);





  //create http server
  http.createServer(function(req, res) {

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
              
      	//store expiry time 10 minutes in the future
        file.expiryTime = new Date().getTime() + (2*60*1000);

        //generate new bitcoin address for payments
        client.cmd('getnewaddress',function(err,address){
          if (err) return console.log(err);
          //console.log(address);
          file.bitcoinAddress = address;
          file.btcBalance = 0.00000000;

          file.btcDownloadCost = Math.max(file.referralBTCPrice * margin, (file.upload.size / 1000000 / minutesPerBTCPerMB * minutesBurnedPerDownload * margin) + file.referralBTCPrice);//max of referral * margin or (our base costs + referral price) * margin - accounts for very low referral cost uploads.


          collection.insert(file, function(err, docs) {

            //var thisID = docs[0]._id;

            id = docs[0]._id;

            collection.count(function(err, count) {
              console.log(format("Uploaded file count since last reset = %s", count));
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


            /*res.writeHead(200, {'content-type': 'text/html'});
            res.write('received upload:<br/><br/>');
            res.write('To retrieve your file use this link: <a href="/download/'+id+'">'+id+'</a><br/><br/>');
            res.write('Your file will be deleted after 10 minutes. For every 1 satoshi sent to this address your file will stay online for another '+minutesPerBTCPerMB/100000000*60+' seconds per MB in size: <a target="_blank" href="https://blockchain.info/address/'+ address+'">'+address+'</a><br/><br/>');
            //debug   res.end(util.inspect({fields: fields, files: files}));
            //*/
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

        var address = req.url.substring(req.url.indexOf('/?payment=') + 10);

        //check payment is received
        client.getBalance(address, 0, function(err, balance) {
          if (err) return console.log(err);

          collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {
            if (item != null){
              if (balance < item.btcDownloadCost){

                if (addressInItemDownloadAddresses(address,item)){ //address could be any address - check it's in the array

                  //allow download (once) 
                  console.log('Downloading paid file : ' + item.upload.path);

                  var file = item.upload.path;
                  var filename = path.basename(file);
                  var mimetype = mime.lookup(file);

                  res.setHeader('Content-disposition', 'attachment; filename=' + filename);
                  res.setHeader('Content-type', mimetype);

                  var filestream = fs.createReadStream(file);
                  filestream.pipe(res);
                  
                  //delete download url
                  collection.update({ '_id': new BSON.ObjectID(fileID) },{ $pull: { downloadAddress: {address: address, paid: true} } }, function(err, doc){
                    if (err) return console.log(err);
                    if(doc != 1) return console.log('Error - ' + doc);
                    console.log('Deleted download address after single paid download.');
                  });

                }else{
                  res.writeHead(200, {'content-type': 'text/plain'});
                  res.write('Address not linked to file.');
                  return res.end();
                }

              }else{
                res.writeHead(200, {'content-type': 'text/plain'});
                res.write('No payment received.');
                return res.end();
              }
            }else{
              res.writeHead(200, {'content-type': 'text/plain'});
              res.write('Error.');
              return res.end();
            }
          });
        });

        return;
      }

      //get path from mongo (if file exists)
      if (fileID.length == 24){
        collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {

            if (item != null){

              //TODO make users pay part to me part to the owner who uploaded the file. owner btc address should be stored on upload.

              //two file types: 1 - prepaid by uploader, anyone who downloads pays and proceeds are split between admin, program (expiry extension), and uploader
              if (item.referralBTCAddress.length > 5){ //if referral address exists. TODO validate address

                //Create new btcaddress for downloader with 15 minutes to pay
                //After payment the user can download using currentURL?payment=NewBitcoinAddress
                client.cmd('getnewaddress',function(err,address){
                  if (err) return console.log(err);

                  collection.update({ '_id': new BSON.ObjectID(fileID) },{ $push: { downloadAddress: {address: address, paid: false} } }, function(err, doc){
                    if (err) return console.log(err);

                    if(doc != 1){
                      console.log('Error - ' + doc);
                      return;
                    }

                    console.log(doc);

                    console.log("Added address " + address + "to file.");

                    var responseItem = {
                      amountToPay: item.btcDownloadCost,
                      timeToPay: '15 minutes',
                      paymentAddress: address,
                      downloadLink: '/download/' + fileID + '/?payment=' + address
                    };

                    //delete download address after 15 minutes if btc payment is not complete.
                    var myTimeout = setTimeout(function() {
                      collection.update({ '_id': new BSON.ObjectID(fileID) },{ $pull: { downloadAddress: {address: address, paid: false} } }, function(err, doc){
                        if (err) return console.log(err);
                        if(doc != 1) return console.log('Error - ' + doc);
                        console.log('Added new address for download payment');
                      });
                    }, 15 * 60 * 1000); //15 minutes

                    var x=0;
                    var myInterval = setInterval(function() {

                      //if payment not made delete the download address
                      client.getBalance(address, 0, function(err, balance) {
                        if (err) return console.log(err);

                        if (balance < item.btcDownloadCost){
                          //if 15 minutes past then address will be deleted by timeout above.
                          
                          //if 15 minutes past then stop this interval
                          if(x >= 90){
                            clearInterval(myInterval); //stop this interval being called again.
                          }
                          
                          x++;

                        }else{
                          //paid
                          clearTimeout(myTimeout); //stop it being deleted.
                          clearInterval(myInterval); //stop this interval being called again.

                          collection.update({ '_id': new BSON.ObjectID(fileID) },{ $pull: { downloadAddress: {address: address, paid: false} } }, function(err, doc){
                            if (err) return console.log(err);
                            if(doc != 1) return console.log('Error - ' + doc);


                            collection.update({ '_id': new BSON.ObjectID(fileID) },{ $push: { downloadAddress: {address: address, paid: true} } }, function(err, doc){
                              if (err) return console.log(err);
                              if(doc != 1) return console.log('Error - ' + doc);

                              console.log('Payment received for download.');

                            });
                          });
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
                client.getBalance(item.bitcoinAddress, 0, function(err, balance) {
                  if (err) return console.log(err);


                  if (balance == 0){
                    res.writeHead(200, {'content-type': 'text/plain'});
                    res.write('Please make payment first.');
                    return res.end();
                  }

                  //Reduce expiry time by bandwidth charge/cost
                  minutesBurned = -1 * minutesBurnedPerDownload * 60 * 1000; //minutes to milliseconds
                  collection.update({ '_id': new BSON.ObjectID(fileID) },{ $inc: { expiryTime: (minutesBurned) } }, function(err, doc){
                    if (err) return console.log(err);

                    if(doc != 1){
                      console.log('Error - ' + doc);
                      return;
                    }   

                    //download file
                    console.log('Downloading : ' + item.upload.path);

                    var file = item.upload.path;
                    var filename = path.basename(file);
                    var mimetype = mime.lookup(file);

                    res.setHeader('Content-disposition', 'attachment; filename=' + filename);
                    res.setHeader('Content-type', mimetype);

                    var filestream = fs.createReadStream(file);
                    filestream.pipe(res);

                  }); 
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
      '<input type="text" name="title">Enter a title (optional)<br>'+
      '<input type="text" name="referralBTCAddress">Enter a refferal address (optional)<br>'+
      '<input type="text" name="referralBTCPrice">Enter a refferal price (optional)<br>'+
      '<input type="file" name="upload"><br>'+
      '<input type="submit" value="Upload">'+
      '</form>'
    );
  }).listen(8080);
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






