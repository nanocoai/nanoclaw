// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// The `channels` branch keeps this file fully populated — it's the
// fully-loaded, runnable branch. Individual `/add-<channel>` skills pull
// single files from this branch onto a user's install, appending their
// own import lines to a leaner barrel on main.

// cli — default channel that ships with main (always on, no credentials).
import './cli.js';

// discord
import './discord.js';

// slack
import './slack.js';
// slack bot-authored inbound guard (registers the bridge inbound policy for
// the 'slack' channel type — installs alongside the slack adapter)
import './slack-a2a-guard.js';

// telegram
import './telegram.js';

// github
// import './github.js';

// linear
import './linear.js';

// google chat
// import './gchat.js';

// microsoft teams
// import './teams.js';

// whatsapp cloud api
import './whatsapp-cloud.js';

// resend (email)
// import './resend.js';

// matrix
// import './matrix.js';

// webex (webhook, via Chat SDK bridge)
// import './webex.js';

// webex-poll (REST polling, no public URL required)
import './webex-poll.js';

// imessage
import './imessage.js';

// mattermost
import './mattermost.js';

// gmail (native, no Chat SDK)

// whatsapp (native, no Chat SDK)
import './whatsapp.js';

// signal (native, no Chat SDK — signal-cli TCP JSON-RPC daemon)
// import './signal.js';

// emacs (native HTTP bridge, no Chat SDK)
// import './emacs.js';

// deltachat (native, no Chat SDK)
// import './deltachat.js'
