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

var config = JSON.parse(fs.readFileSync(config_file).toString())

var cleanTask = cron.schedule(config.cron_schedule, function(){
	console.log('Running the cleanup script')
	let cleaner = new Cleaner(config)
	var repos = fs.readFileSync(repos_file).toString().split("\n")
	cleaner.cleanRepos(repos)
});


//catches ctrl+c event
process.on('SIGINT', ()=>{

	console.log('SIGINT seen.  Calling stop on  the cleanup script.')
	cleanTask.stop()
	console.log('Cron stopped.  Should exit after current run completes.')
});