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


MongoClient.connect('mongodb://127.0.0.1:27017/test', function(err, db) { 

  if(err) throw err; 
  collection = db.collection('uploadedFiles');
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
          console.log(items[i]);
          console.log('successfully deleted file.');
        });
      }

    });
  }, null, true);    


  //connect to bitcoin daemon
  var client = new bitcoin.Client({
    host: 'localhost',
    port: 8332,
    user: 'hughht5',
    pass: 'OSi32SGpoik'
  }); 


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
        file.expiryTime = new Date().getTime() + (10*60*1000);

        //generate new bitcoin address for payments
        client.cmd('getnewaddress',function(err,address){
          if (err) return console.log(err);
          console.log(address);
          file.bitcoinAddress = address;

          collection.insert(file, function(err, docs) {

            var thisID = docs[0]._id;

            id = docs[0]._id;

            collection.count(function(err, count) {
              console.log(format("Uploaded file count since last reset = %s", count));
            });

            //every 10 seconds check if payment is received
            var paymentCron = new cronJob('*/10 * * * * *', function(){
              //if bitcoin payment is received then extend expiry time by 1 minute / satoshi     
              client.getBalance(address, 0, function(err, balance) {
                if (err) return console.log(err);
                
                collection.find({_id: thisID}).toArray(function(err, items) {
                  if (items.length != 0){
                    console.log('Balance:', balance);
                    if (balance > 0){
                      collection.update({ _id: thisID },{ $inc: { expiryTime: (60*1000) } });
                      console.log('added 1 minute to expiryTime.');
                      
                      //stop cron
                      clearTimeout(this.timer);
                      this.events = [];
                      paymentCron = null;
                    }
                  }else{
                    //if file has already expired - stop cron
                    clearTimeout(this.timer);
                    this.events = [];
                    paymentCron = null;
                  }
                });
              }); 
            }, null, true);


            //send response to user
            res.writeHead(200, {'content-type': 'text/html'});
            res.write('received upload:\n\n');
            res.write('To retrieve your file use this link: <a href="/download/'+id+'">'+id+'</a>\n\n');
            res.write('Your file will be deleted after 10 minutes. For every 1 satoshi sent to this address your file will stay online for another 1 minute: ' + address + ' \n\n');
            //debug   res.end(util.inspect({fields: fields, files: files}));
            res.end();
            
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
              res.end();
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
