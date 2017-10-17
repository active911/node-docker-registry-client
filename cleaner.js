var bunyan = require('bunyan');
var drc = require('./lib/index.js')
var https = require('https');
var fs = require('fs');

module.exports = function(config){
	var self = this;
	self.config = config;
	

	//Tail recursion so we do this serially
	self.cleanRepos = function(local_repos){
		// This package uses https://github.com/trentm/node-bunyan for logging.
		var log = bunyan.createLogger({
			name: 'regplay',
			// TRACE-level logging will show you all request/response activity
			// with the registry. This isn't suggested for production usage.
			level: self.config.logging
		});
		if(local_repos.length < 1){
			log.info("Cleaning run complete")
			return
		}
		let repo = local_repos.shift()
		let REPO = self.config.host + ":" + self.config.port + "/" + repo
		log.info("Cleaning " + REPO)
		let client = drc.createClientV2({
			name: REPO,
			log: log,
			// Optional basic auth to the registry
			username: self.config.username,
			password: self.config.password,
			// Optional, for a registry without a signed TLS certificate.
			insecure: false
			// ... see the source code for other options
		});
		let cutoff = new Date();
		cutoff.setDate(cutoff.getDate()-self.config.cutoff_age_days);

		client.listTags((err, data)=>{
			if(err){
				log.error({repo:REPO}, err)
				self.cleanRepos(local_repos, self.config)
				return
			}
			let deleter = new Promise((fulfill, reject) => {

				let keepers = []
				let deletions = []
				let tags = data.tags
				let counter = 0;
				if(tags == null){
					log.warn({repo:REPO}, "No tags for the repo.  Skipping")
				}
				else if(tags.length > 5){
					log.debug("Looking at " + tags.length + " tags")
					data.tags.forEach((tag, index)=>{
						client.getManifest({"ref":tag}, (err, data, res, manifestStr)=>{

							if(data){
								let v1Record = JSON.parse(data.history[0].v1Compatibility)
								//We don't use this digest because the client seems to be giving back v1 digests
								//let digest = res.headers['docker-content-digest']
								if(['develop','master','release', 'latest'].indexOf(tag) < 0 && new Date(v1Record.created) < cutoff){
									log.debug({repo:REPO}, "DELETING " + tag)
									deletions.push(tag)
								}
								else{
									log.debug({repo:REPO},"KEEPING " + tag)
									keepers.push(tag)
								}
							}
							else{
								log.debug({repo:REPO},"Empty manifest for " + tag)
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

			deleter.then(async (results)=>{
					log.info({repo:REPO},"Keeping: " + results.k.length)
					log.info({repo:REPO},"Deleting: " + results.d.length)
					if(results.k.length < 1){
						reject("Cannot delete all images for a repo")
					}
					else{
						//Grab the auth token from the client
						let clientHeaders = client._headers
						clientHeaders.accept = "application/vnd.docker.distribution.manifest.v2+json"

						//Compile a list of the keeper digests to make sure we don't delete any of them
						//Sometimes, master/develop/release/latest can be an old image, which is also tagged by a commit hash

						let keeperDigests = []

						for(let j=0;j<results.k.length;j++){
							let tag = results.k[j]
							let tagPath = "/v2/" + repo + "/manifests/" + tag

							log.debug({repo:REPO},"Getting keeper digest for " + tagPath)
							keeperDigests.push(await self.getDigest(tagPath, clientHeaders))
						}
						
						log.info({repo:REPO},"Keeper Digests: " + keeperDigests)

						let promises = []
						for(let j=0;j<results.d.length;j++){
							promises.push(new Promise((fulfill, reject)=>{
								let tag = results.d[j]
								
								let tagPath = "/v2/" + repo + "/manifests/" + tag
		
								log.debug({repo:REPO},"Getting deletion digest for " + tagPath)
								self.getDigest(tagPath,clientHeaders)
									.then((digest)=>{
										if(keeperDigests.indexOf(digest) > -1){
											log.info({repo:REPO},tagPath + " has the same digest as a keeper.  Skipping Deletion.")
											fulfill(tag)
										}
										else{
											log.info({repo:REPO},"Deleting " + digest)
											let deletePath = "/v2/" + repo + "/manifests/" + digest
											var request = https.request({
												host: self.config.host,
												port: self.config.port,
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
										}
									})
				
							}))
						}
						return Promise.all(promises)
					}
			})
			.then(()=>{
					self.cleanRepos(local_repos, self.config)
			},()=>{
					self.cleanRepos(local_repos, self.config)
			})
			
		})
	}


	self.getDigest = function(path, headers){
		return new Promise((fulfill, reject)=>{
			var request = https.request({
				host: self.config.host,
				port: self.config.port,
				path: path,
				method: 'GET',
				headers: headers
			},(res) => {
				let digest = res.headers["docker-content-digest"]
				fulfill(digest)
			});

			request.on('error', (e) => {
				console.error(e)
				reject(e)
			});
			request.end()
		})
	}
}