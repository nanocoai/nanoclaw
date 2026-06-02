on run
	my launchNanoTalk()
end run

on reopen
	my launchNanoTalk()
end reopen

on launchNanoTalk()
	set targetUrl to "http://127.0.0.1:4377"
	
	try
		do shell script "launchctl kickstart gui/$(id -u)/com.nanoclaw.nanotalk-dashboard >/dev/null 2>&1 || true"
	end try
	
	delay 0.5
	do shell script "open -na '/Applications/Google Chrome.app' --args --app=" & quoted form of targetUrl
end launchNanoTalk
