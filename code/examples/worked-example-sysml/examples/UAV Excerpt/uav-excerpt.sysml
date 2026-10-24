package UavExcerpt {
	requirement AttitudeHold { attribute priority = "high"; }
	action StabilizeAttitude;
	part FlightController {
		attribute criticality = "A"; attribute mass = 2.5;
		port cmdOut { out item cmd; }
	}
	part PowerUnit {
		attribute criticality = "B"; attribute mass = 4.0;
		port cmdIn { in item cmd; }
	}
	connect FlightController.cmdOut to PowerUnit.cmdIn;
	allocate StabilizeAttitude to FlightController;
	satisfy AttitudeHold by FlightController;
	verification HilAttitudeTest {
		attribute method = "test";
		objective { verify AttitudeHold; }
	}
	view PowerView { expose PowerUnit::*; }
	dependency FlightController to PowerUnit;
}
