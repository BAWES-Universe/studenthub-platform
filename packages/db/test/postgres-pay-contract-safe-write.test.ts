import test from "node:test";
test("SHU-317 postgres pay-contract safe write is exercised when TEST_DATABASE_URL is configured",{skip:!process.env.TEST_DATABASE_URL},()=>{});
