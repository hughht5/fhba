File Hosting Bitcoin Agent
====

##WARNING
This project is in early development. It may swallow bitcoins that are thrown its way. Use with caution.


##Usage
There are 2 ways to use this program:
 - upload a file and pay / MB / minute. Each download costs 10 minutes and files are deleted when the timer expires.
 - upload a file with a fee and a referral address. Each download costs that fee (which goes to the uploader) and an extra percentage to keep the file online for longer. This allows artists to upload files and distribute them on a pay / view model.

###API

Upload a file and pay per minute / MB. Anyone with the link can download the file. This is good for short term file hosting / sharing.
```
/upload
params: 
 upload, type: file
 title, type: text, optional
```

Upload a file for pay / view. Each time someone wants to download it they have to pay you a referral fee plus a little extra to host the file for longer.
```
Path: /upload
Params:
 upload, type: file
 title, type: text, optional
 referralBTCAddress, type: text
 referralBTCPrice, type: text
```

View the status of a file
```
Path: /status/fileID
```

Download file on pay per MB/minute
```
Path: /download/fileID
```


Download file on pay per view
```
Path: /download/fileID

- customer is presented with unique payment address. Once paid:
Path: downloadLink provided from response
```


##How does it work?
A bitcoind instance runs in the background to generate addresses and monitor for payments.

When a file is uploaded a unique payment address is made for that file. Any payments to that address extend the hosting length of that file on a satoshi / MB / minute basis. 

Pay per minute: an expiry time is set on each uploaded file 30 minutes into the future. Before anyone can download a payment must be made. Each payment made extends the expiry time into the future. A unique download URL is created and anyone with that URL can download the file. Each download cost 10 minutes in hosting (takes 10 minutes from the expiry time) to cover bandwidth costs.

Pay per view: an expiry time is set on each uploaded file 30 minutes into the future. The uploader can optionally pay for the file to be hosted for longer. Each person who downloads the file pays a referral fee plus a percentage of that to extend the expiry time of that file and host it for longer. A unique download URL is created for that file. Each time someone hits that URL a unique payment address and a one off download URL are created for that person. The download URL only works once that requested referral fee is paid.

Every minute expired files are deleted and all hosting fees are moved to the profit account in bitcoind.

##Dependancies:

###bitcoind
sudo apt-get install python-software-properties

sudo add-apt-repository ppa:bitcoin/bitcoin

sudo apt-get update

sudo apt-get install bitcoind

mkdir ~/.bitcoin/

###mongodb
sudo apt-get install mongodb

###nodejs
sudo apt-get update

sudo apt-get install -y python-software-properties python g++ make

sudo add-apt-repository ppa:chris-lea/node.js

sudo apt-get update

sudo apt-get install nodejs

##To run
node server.js
