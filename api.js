var formidable = require('formidable'),
    util = require('util');


var collection = null;
 var MongoClient = require('mongodb').MongoClient
    , format = require('util').format;

  MongoClient.connect('mongodb://127.0.0.1:27017/test', function(err, db) {
    if(err) throw err;

    collection = db.collection('uploadedFiles');
  })


exports.uploadFile = function(req, res) {
	// parse a file upload
    var form = new formidable.IncomingForm();
    form.keepExtensions = true;

    form.parse(req, function(err, fields, files) {
      console.log("2");
      var id = null;
      console.log("3");

      //store name of file and details in mongodb
      files.title = fields.title;
      collection.insert(files, function(err, docs) {

        id = docs[0]._id;

        collection.count(function(err, count) {
          console.log(format("Uploaded file count since last reset = %s", count));
        });

        console.log("4");

        res.writeHead(200, {'content-type': 'text/plain'});
        res.write('received upload:\n\n');
        res.write('To retrieve your file use id: ' + id + '\n\n');
        res.end(util.inspect({fields: fields, files: files}));

      });
    });
    console.log("5");

};

exports.downloadFile = function(req, res){


	var file = __dirname + '/upload-folder/dramaticpenguin.MOV';

	var filename = path.basename(file);
	var mimetype = mime.lookup(file);

	res.setHeader('Content-disposition', 'attachment; filename=' + filename);
	res.setHeader('Content-type', mimetype);

	var filestream = fs.createReadStream(file);
	filestream.pipe(res);


    res.writeHead(200, {'content-type': 'text/plain'});
    res.write('download files here:\n\n');
    res.end();
    return;
}