from datetime import datetime,timedelta,timezone
from uuid import UUID
from p2p_energy_shared.models import UserRegistry
from data_generator.energy_config import load_energy_config
from data_generator.snapshot_builder import build_energy_snapshot
config=load_energy_config('services/data-generator/config/energy-generation-config.json')
users=[]
for i in range(1,201):
 uid=str(UUID(int=i,version=4));users.append(dict(userId=uid,name=f'Candidate {i}',email=f'candidate-{i}@example.com',physicalAddress='Simulation',xKm=0,yKm=0,preferredEnergyType='ANY',reputation=80,hederaAccountId=f'0.0.{i+1000}',evmAddress='0x'+format(i,'040x')))
registry=UserRegistry.model_validate({'schemaVersion':'1.0.0','users':users})
start=datetime(2026,10,1,tzinfo=timezone.utc)
for h in range(24*40):
 slot=(start+timedelta(hours=h)).strftime('%Y-%m-%dT%H:00:00Z')
 snapshot=build_energy_snapshot(registry,slot,config)
 sellers=[x for x in snapshot.users if x.market_role.value=='SELLER']
 buyers=[x for x in snapshot.users if x.market_role.value=='BUYER']
 for s in sellers:
  eligible=[b for b in buyers if b.max_price_microusd_per_kwh>=s.ask_price_microusd_per_kwh and b.required_energy_wh*s.ask_price_microusd_per_kwh%1000==0]
  for i,b in enumerate(eligible):
   for c in eligible[i+1:]:
    if b.required_energy_wh+c.required_energy_wh<=s.available_energy_wh:
     print(slot,'seller',s.user_id,s.available_energy_wh,s.ask_price_microusd_per_kwh,'buyers',b.user_id,b.required_energy_wh,c.user_id,c.required_energy_wh,flush=True);raise SystemExit(0)
print('no candidate found')
