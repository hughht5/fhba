File Hosting Bitcoin Agent
====

##Dependancies:

###bitcoind
sudo aptitude install python-software-properties

sudo add-apt-repository ppa:bitcoin/bitcoin

sudo aptitude update

sudo aptitude install bitcoind

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
