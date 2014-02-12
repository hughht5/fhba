 var formidable = require('formidable'),
    http = require('http'),
    fs = require('fs'),
    url = require("url"),
    util = require('util');

var collection = null;
var MongoClient = require('mongodb').MongoClient
    , format = require('util').format;
var cronJob = require('cron').CronJob;

var mongo = require('mongodb');
var BSON = mongo.BSONPure;
var bitcoin = require('bitcoin');

var minutesPerBTCPerMB = 1051200; //2 years in minutes


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
            collection.update({ _id: thisID },{ $set: { btcBalance: (balance) } });

            //extend expiry time by correct amount.
            var btcDiff = balance - oldBalance;
            var minutesToExtend = btcDiff*minutesPerBTCPerMB/filesize;
            collection.update({ _id: thisID },{ $inc: { expiryTime: (minutesToExtend*1000) } });
            console.log('extended expiry time by ' + minutesToExtend);

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

      //get path from mongo (if file exists)
      var fileID = req.url.substring(downloadURL.length);
      if (fileID.length == 24){
        collection.findOne({'_id':new BSON.ObjectID(fileID)}, function(err, item) {

            if (item != null){

              //TODO add reducing expiry time per downloaded MB.
              //TODO dont let file be downloaded if nothing has been paid.

              //download file
              console.log('Downloading : ' + item.upload.path);

              var path = require('path');
              var mime = require('mime');

              //var file = __dirname + item.upload.path;
              var file = item.upload.path;

              var filename = path.basename(file);
              var mimetype = mime.lookup(file);

              res.setHeader('Content-disposition', 'attachment; filename=' + filename);
              res.setHeader('Content-type', mimetype);

              var filestream = fs.createReadStream(file);
              filestream.pipe(res);

            }else{
              res.writeHead(200, {'content-type': 'text/plain'});
              res.write('File not found.\n\n');
              return res.end();
            }

        });
      }else{
          res.writeHead(200, {'content-type': 'text/plain'});
          res.write('File not found.\n\n');
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
              res.write('File not found.\n\n');
              return res.end();
            }

        });
      }else{
          res.writeHead(200, {'content-type': 'text/plain'});
          res.write('File not found.\n\n');
          res.end();
      }
      return;
    }

    // show a file upload form
    res.writeHead(200, {'content-type': 'text/html'});
    res.end(
      '<form action="/upload" enctype="multipart/form-data" method="post">'+
      '<input type="text" name="title"><br>'+
      '<input type="file" name="upload"><br>'+
      '<input type="submit" value="Upload">'+
      '</form>'
    );
  }).listen(8080);
})


function strStartsWith(str, prefix) {
    return str.indexOf(prefix) === 0;
}
