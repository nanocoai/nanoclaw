on run
	my launchCody()
	quit
end run

on reopen
	my launchCody()
	quit
end reopen

on launchCody()
	set targetUrl to "https://web.telegram.org/k/#@sawyer_cody_bot"
	set targetBounds to {580, 70, 1100, 900}
	if my focusChromeWindowForUrl(targetUrl, targetBounds) is false then
		do shell script "open -na '/Applications/Google Chrome.app' --args --profile-directory='Profile 1' --app=" & quoted form of targetUrl
		my waitForChromeWindow(targetUrl, targetBounds)
	end if
end launchCody

on waitForChromeWindow(targetUrl, targetBounds)
	repeat 16 times
		delay 0.25
		if my focusChromeWindowForUrl(targetUrl, targetBounds) then return true
	end repeat
	return false
end waitForChromeWindow

on focusChromeWindowForUrl(targetUrl, targetBounds)
	try
		tell application "Google Chrome"
			repeat with chromeWindow in windows
				try
					if (URL of active tab of chromeWindow) starts with targetUrl then
						set bounds of chromeWindow to targetBounds
						set index of chromeWindow to 1
						activate
						return true
					end if
				end try
			end repeat
		end tell
	end try
	return false
end focusChromeWindowForUrl
