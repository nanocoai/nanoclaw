"""Download checksum-pinned OneCLI sources; select its pure app registry unchanged."""
import hashlib, json, pathlib, re, sys, urllib.request
root=pathlib.Path(__file__).resolve().parent
manifest=json.loads((root/'upstream.json').read_text())
source=root/'src'
for name,checksum in manifest['files'].items():
    data=urllib.request.urlopen(f"https://raw.githubusercontent.com/onecli/onecli/{manifest['commit']}/apps/gateway/src/{name}").read()
    if hashlib.sha256(data).hexdigest()!=checksum: raise RuntimeError(f'OneCLI source checksum mismatch: {name}')
    if name=='apps.rs':
        text=data.decode()
        # Keep upstream declarations and registry data. Exclude all auth/network
        # implementation; the helper only resolves the provider for a request.
        prefix=text[:text.index('// ── Public API')]
        prefix=re.sub(r'^use (?:base64::Engine|crate::inject::Injection|crate::util::parse_jwt_exp);\n','',prefix,flags=re.M)
        names=['all_providers','provider_for_host','provider_for_host_and_path','host_has_path_scoped_providers']
        for fn in names:
            start=re.search(r'^(?:pub\(crate\) )?fn '+fn+r'\(',text,re.M).start()
            brace=text.index('{',start);end=brace+1;depth=1
            while depth:
                if text[end]=='{':depth+=1
                if text[end]=='}':depth-=1
                end+=1
            prefix+='\n'+text[start:end]+'\n'
        data=prefix.encode()
    target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
