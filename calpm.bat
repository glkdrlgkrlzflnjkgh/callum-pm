:: CalPM wrapper.
:: it will call the index.js file in the same directory as this batch file.
:: to sum up: if it is on your PATH you can run calPM from anywhere!
@echo off
node "%~dp0\index.js" %*
