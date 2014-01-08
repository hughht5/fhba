 var formidable = require('formidable'),
    http = require('http'),
    fs = require('fs'),
    url = require("url"),
    util = require('util');

var collection = null;
 var MongoClient = require('mongodb').MongoClient
    , format = require('util').format;

var mongo = require('mongodb');
var BSON = mongo.BSONPure;

MongoClient.connect('mongodb://127.0.0.1:27017/test', function(err, db) {
  if(err) throw err;

  collection = db.collection('uploadedFiles');


  http.createServer(function(req, res) {
    
    if (req.url == '/upload' && req.method.toLowerCase() == 'post') {
      // parse a file upload
      var form = new formidable.IncomingForm();
      form.keepExtensions = true;


      form.parse(req, function(err, fields, files) {
        
        var id = null;

        //store name of file and details in mongodb
        files.title = fields.title;
        collection.insert(files, function(err, docs) {

          id = docs[0]._id;

          collection.count(function(err, count) {
            console.log(format("Uploaded file count since last reset = %s", count));
          });


          res.writeHead(200, {'content-type': 'text/html'});
          res.write('received upload:\n\n');
          res.write('To retrieve your file use this link: <a href="/download/'+id+'">'+id+'</a>\n\n');
          //debug   res.end(util.inspect({fields: fields, files: files}));
          res.end();

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
