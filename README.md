File Hosting Bitcoin Agent
====

##WARNING
This project is in early development. It will swallow bitcoins that are thrown it's way. Use with caution.

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
