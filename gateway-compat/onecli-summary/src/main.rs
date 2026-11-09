#![allow(dead_code, unexpected_cfgs)]
use base64::Engine;
use serde::Deserialize;
use std::io::{self, Read};
mod summary;
mod cloud_summary;
mod apps;
mod ee_apps {
    pub(crate) fn providers() -> &'static [crate::apps::AppProvider] { &[] }
}
#[derive(Deserialize)]
struct Request { host: String, method: String, path: String, content_type: Option<String>, body: String }
fn summarize(req: Request) -> Result<summary::ApprovalSummary, Box<dyn std::error::Error>> {
    let host=req.host.strip_suffix(":443").unwrap_or(&req.host);
    let provider=apps::provider_for_host_and_path(host,&req.path).map(|(id,_)| id).unwrap_or(host);
    let body=base64::engine::general_purpose::STANDARD.decode(req.body)?;
    Ok(summary::summarize_request(provider,&req.method,&req.path,req.content_type.as_deref(),if body.is_empty(){None}else{Some(&body[..body.len().min(16384)])}))
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let mut input=String::new(); io::stdin().take(32769).read_to_string(&mut input)?;
    if input.len()>32768 {return Err("summary input too large".into())}
    let result=summarize(serde_json::from_str(&input)?)?;
    println!("{}",serde_json::to_string(&result)?);
    Ok(())
}
#[cfg(test)]
mod parity {
 use super::*;
 #[test]
 fn routes_match_upstream_summarizer() {
  for (host,path,provider,body) in [
   ("gmail.googleapis.com","/gmail/v1/users/me/messages/send","gmail",r#"{"raw":"VG86IGFAYi50ZXN0DQpTdWJqZWN0OiBUZXN0DQoNCkhlbGxv"}"#),
   ("www.googleapis.com","/gmail/v1/users/me/messages/send","gmail",r#"{"raw":"VG86IGFAYi50ZXN0DQpTdWJqZWN0OiBUZXN0DQoNCkhlbGxv"}"#),
   ("www.googleapis.com","/calendar/v3/calendars/primary/events","google-calendar",r#"{"summary":"Planning","start":{"dateTime":"2026-09-14T10:00:00Z"}}"#),
   ("api.github.com","/repos/example/repo/issues/1/comments","github",r#"{"body":"hello","token":"secret"}"#),
   ("unknown.test","/items","unknown.test",r#"{"password":"secret","name":"sample"}"#),
  ] {
   let expected=summary::summarize_request(provider,"POST",path,Some("application/json"),Some(body.as_bytes()));
   let actual=summarize(Request{host:host.into(),method:"POST".into(),path:path.into(),content_type:Some("application/json".into()),body:base64::engine::general_purpose::STANDARD.encode(body)}).unwrap();
   assert_eq!(actual,expected,"{host}{path}");
  }
 }
}
