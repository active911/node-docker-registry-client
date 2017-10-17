var cron = require('node-cron')
var fs = require('fs');

var Cleaner = require('./cleaner')

var params = process.argv

//The first passed in parameter should be a file with the repos we need to clean
var repos_file = params[2]
var config_file = params[3]
if(!repos_file){
	console.error("Requires repos file param 1")
	process.exit(1)
}
if(!config_file){
	console.error("Requires config file param 2")
	process.exit(1)
}



var repos = fs.readFileSync(repos_file).toString().split("\n")


var config = JSON.parse(fs.readFileSync(config_file).toString())

cron.schedule(config.cron_schedule, function(){
	console.log('Running the cleanup script')
	let cleaner = new Cleaner(config)
	cleaner.cleanRepos(repos)
});