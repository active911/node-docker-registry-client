//Super messy 

var bunyan = require('bunyan');
var drc = require('./lib/index.js')
var https = require('https');
var fs = require('fs');

var params = process.argv;

//The first passed in parameter should be a file with the repos we need to clean
var repos_file = params[2];
var config_file = params[3]
if(!repos_file){
	console.error("Requires repos file param 1")
	process.exit(1)
}
if(!config_file){
	console.error("Requires config file param 2")
	process.exit(1)
}



var repos = fs.readFileSync(repos_file).toString().split("\n");


var config = JSON.parse(fs.readFileSync(config_file).toString());

// This package uses https://github.com/trentm/node-bunyan for logging.
var log = bunyan.createLogger({
    name: 'regplay',
    // TRACE-level logging will show you all request/response activity
    // with the registry. This isn't suggested for production usage.
    level: config.logging
});

cleanRepos(repos, config)

//Tail recursion so we do this serially
function cleanRepos(local_repos, config){
	let repo = local_repos.shift()
	let REPO = config.host + ":" + config.port + "/" + repo
	log.info("Cleaner","Cleaning " + REPO)
	let client = drc.createClientV2({
		name: REPO,
		log: log,
		// Optional basic auth to the registry
		username: config.username,
		password: config.password,
		// Optional, for a registry without a signed TLS certificate.
		insecure: false
		// ... see the source code for other options
	});
	let cutoff = new Date();
	cutoff.setDate(cutoff.getDate()-config.cutoff_age_days);

	client.listTags((err, data)=>{
		if(err){
			log.error({repo:REPO}, err)
			cleanRepos(local_repos, config)
			return
		}
		let deleter = new Promise((fulfill, reject) => {

			let keepers = []
			let deletions = []
			let tags = data.tags
			let counter = 0;
			if(tags.length > 5){
				log.debug("Looking at " + tags.length + " tags")
				data.tags.forEach((tag, index)=>{
					client.getManifest({"ref":tag}, (err, data, res, manifestStr)=>{

						if(data){
							let v1Record = JSON.parse(data.history[0].v1Compatibility)
							let digest = res.headers['docker-content-digest']
							if(['develop','master','release', 'latest'].indexOf(tag) < 0 && new Date(v1Record.created) < cutoff){
								log.debug({repo:REPO}, "DELETING " + tag)
								deletions.push(tag)
							}
							else{
								log.debug({repo:REPO},"KEEPING " + tag)
								keepers.push(digest)
							}
						}
						else{
							log.info({repo:REPO},"Empty manifest for " + tag)
						}
						if(counter++ == tags.length-1){
							fulfill({"k":keepers, "d":deletions})
						}
					})
				})
			}
			else{
				log.info({repo:REPO},"Skipping " + REPO + " because it has <5 tags")
				fulfill({"k": tags , "d": []})
			}
		})

		deleter.then((results)=>{
				log.info({repo:REPO},"Keeping: " + results.k.length)
				log.info({repo:REPO},"Deleting: " + results.d.length)
				if(results.k.length < 1){
					reject("Cannot delete all images for a repo")
				}
				else{
					//Grab the auth token from the client
					let clientHeaders = client._headers
					clientHeaders.accept = "application/vnd.docker.distribution.manifest.v2+json"

					let promises = []
					for(let j=0;j<results.d.length;j++){
						promises.push(new Promise((fulfill, reject)=>{
							let tag = results.d[j]
							
							let tagPath = "/v2/" + repo + "/manifests/" + tag
	
							getDigest(tagPath,clientHeaders, config)
								.then((digest)=>{
			
									log.info({repo:REPO},"Deleting " + digest)
									let deletePath = "/v2/" + repo + "/manifests/" + digest
									var request = https.request({
										host: config.host,
										port: config.port,
										path: deletePath,
										method: 'DELETE',
										headers: clientHeaders
									},(res) => {
										/*log.info("Cleaner",'statusCode:', res.statusCode);
										log.info("Cleaner",'headers:', res.headers);
										res.on('data', (d) => {
											process.stdout.write(d);
										});*/
										fulfill(tag)
									});
					
									request.on('error', (e) => {
										reject(e)
									});
									request.end();
					
								})
			
						}))
					}
					return Promise.all(promises)
				}
		})
		.then(()=>{
			if(local_repos.length>0){
				cleanRepos(local_repos, config)
			}
		},()=>{
			if(local_repos.length>0){
				cleanRepos(local_repos, config)
			}
		})
		
	})
}


function getDigest(path, headers, config){
	return new Promise((fulfill, reject)=>{

		log.debug("Cleaner","Getting digest for " + path)
		var request = https.request({
			host: config.host,
			port: config.port,
			path: path,
			method: 'GET',
			headers: headers
		},(res) => {
			let digest = res.headers["docker-content-digest"]
			fulfill(digest)
		});

		request.on('error', (e) => {
			console.error(e);
		  });
		  request.end();
	})
}