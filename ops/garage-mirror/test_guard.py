import copy
import unittest
from unittest.mock import patch
import guard

SHA = "a" * 40
def fixture():
    return {
        guard.GH: ({"full_name":guard.SOURCE,"private":True,"visibility":"private","default_branch":"main"}, {}),
        guard.GH + "/git/ref/heads/main": ({"ref":"refs/heads/main","object":{"type":"commit","sha":SHA}}, {}),
        guard.GL: ({"id":guard.TARGET_ID,"path_with_namespace":guard.TARGET_PATH,"http_url_to_repo":guard.TARGET_URL,"visibility":"private","shared_with_groups":[]}, {}),
        guard.GL + "/members/all?per_page=100": ([{"username":guard.OWNER,"access_level":50,"state":"active"}], {"x-total":"1","x-total-pages":"1"}),
        guard.GL + "/repository/branches/main": ({"name":"main","commit":{"id":"b"*40}}, {})
    }
class GuardTests(unittest.TestCase):
    def run_case(self, change=None, after=False):
        data=fixture(); calls=[]; pushes=[]
        if change and not after: change(data)
        def fetch(url,token,host):
            calls.append((url,host))
            self.assertEqual(token, "gh-test" if host=="github" else "gl-test")
            return copy.deepcopy(data[url])
        def push(sha,token):
            pushes.append((sha,token))
            data[guard.GL + "/repository/branches/main"][0]["commit"]["id"]=sha
            if change and after: change(data)
        try: guard.guarded_sync("gh-test","gl-test",SHA,fetch,push)
        except guard.Blocked: return False, calls, pushes
        return True, calls, pushes
    def test_verified_exact_main_only_and_postflight(self):
        ok,calls,pushes=self.run_case()
        self.assertTrue(ok); self.assertEqual(pushes,[(SHA,"gl-test")])
        self.assertEqual(len(calls),10); self.assertEqual(calls[:5],calls[5:])
    def test_rejects_drift_before_push(self):
        for key,value in [("visibility","public"),("id",1),("path_with_namespace","other/garage"),("http_url_to_repo","https://foreign.example/repo.git"),("shared_with_groups",[{"id":1}])]:
            with self.subTest(key=key):
                ok,_,pushes=self.run_case(lambda d:d[guard.GL][0].update({key:value}))
                self.assertFalse(ok); self.assertEqual(pushes,[])
    def test_rejects_source_identity_privacy_and_moved_ref(self):
        for url,key,value in [(guard.GH,"private",False),(guard.GH,"visibility","internal"),(guard.GH,"full_name","other/garage"),(guard.GH,"default_branch","other"),(guard.GH+"/git/ref/heads/main","object",{"type":"commit","sha":"b"*40})]:
            with self.subTest(key=key):
                ok,_,pushes=self.run_case(lambda d:d[url][0].update({key:value}))
                self.assertFalse(ok);self.assertEqual(pushes,[])
    def test_rejects_member_change_and_pagination(self):
        url=guard.GL+"/members/all?per_page=100"
        for change in [lambda d:d[url][0].append({"username":"other"}),lambda d:d[url][0][0].update({"state":"blocked"}),lambda d:d[url][0][0].update({"access_level":40}),lambda d:d[url][0][0].update({"username":"other"}),lambda d:d[url][1].update({"x-next-page":"2"}),lambda d:d[url][1].update({"link":'<next>; rel="next"'}),lambda d:d[url][1].update({"x-total":"2"}),lambda d:d[url][1].update({"x-total-pages":"2"})]:
            ok,_,pushes=self.run_case(change);self.assertFalse(ok);self.assertEqual(pushes,[])
    def test_postflight_drift_is_not_success(self):
        ok,_,pushes=self.run_case(lambda d:d[guard.GL][0].update({"visibility":"public"}),after=True)
        self.assertFalse(ok);self.assertEqual(len(pushes),1)
    def test_already_synchronized_no_repeat_push(self):
        ok,_,pushes=self.run_case(lambda d:d[guard.GL+"/repository/branches/main"][0]["commit"].update({"id":SHA}))
        self.assertTrue(ok);self.assertEqual(pushes,[])
    def test_wrong_target_head_is_not_success(self):
        ok,_,pushes=self.run_case(lambda d:d[guard.GL+"/repository/branches/main"][0]["commit"].update({"id":"c"*40}),after=True)
        self.assertFalse(ok);self.assertEqual(len(pushes),1)
    def test_invalid_target_head_blocks_write(self):
        ok,_,pushes=self.run_case(lambda d:d[guard.GL+"/repository/branches/main"][0]["commit"].update({"id":"bad"}))
        self.assertFalse(ok);self.assertEqual(pushes,[])
    def test_missing_credentials_no_network(self):
        with self.assertRaises(guard.Blocked):guard.verify("", "gl-test",SHA,lambda *_:self.fail("network"))
    def test_fixed_request_rejects_unknown_endpoint(self):
        with self.assertRaises(guard.Blocked):guard.request("https://other.example/", "token","gitlab")
    def test_redirect_handler_rejects(self):
        with self.assertRaises(guard.Blocked):guard.RejectRedirect().redirect_request(None,None,302,None,None,"https://other.example/")
    @patch("guard.subprocess.run")
    def test_push_exact_ref_no_secret_or_force(self, run):
        run.return_value.returncode=0
        guard.push_exact(SHA,"gl-test")
        args=run.call_args.args[0];kw=run.call_args.kwargs
        self.assertIn(guard.TARGET_URL,args);self.assertIn(SHA+":refs/heads/main",args)
        self.assertNotIn("gl-test"," ".join(args));self.assertNotIn("--force",args)
        self.assertNotIn("--mirror",args);self.assertNotIn("--prune",args)
        self.assertIn("--no-follow-tags",args);self.assertIn("http.followRedirects=false",args)
        self.assertTrue(kw["capture_output"]);self.assertTrue(kw["env"]["GARAGE_GITLAB_AUTH"].startswith("Authorization: Basic "))
    @patch("guard.subprocess.run")
    def test_uncertain_push_has_no_retry(self,run):
        run.return_value.returncode=1
        with self.assertRaises(guard.Blocked):guard.push_exact(SHA,"gl-test")
        self.assertEqual(run.call_count,1)
if __name__=="__main__":unittest.main()
